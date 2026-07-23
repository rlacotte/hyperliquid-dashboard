"""Moteur d'alertes : évalue les 5 critères sur un snapshot de marché.

Modèle anti-bruit :
- Au plus UNE alerte active (non résolue) par (coin, criterion). Tant qu'elle
  est active, on ne recrée pas d'alerte (pas de spam à chaque cycle).
- Si la condition redevient normale, l'alerte est marquée résolue (active=0).
- Une nouvelle alerte ne sera créée que si la condition se déclenche à nouveau.

Critères :
1. Funding rate élevé (|funding| > seuil)
2. Pic d'Open Interest (variation OI sur fenêtre lookback)
3. Volume anormal (pic du TAUX de volume vs baseline — pas de seuil absolu)
4. Variation de prix (delta % sur fenêtre)
5. Confluence (agrégation directionnelle pondérée des 4 précédents)

Accès base : un cycle évalue ~200 coins x 5 critères. Interroger la base par
couple (le modèle d'origine, viable en SQLite locale) représenterait ~1500
allers-retours réseau sur une base distante. L'état des alertes actives est donc
chargé une fois en début de cycle, les écritures sont accumulées dans un
_CycleWriter, et un flush final les applique en 3 requêtes.
"""
from __future__ import annotations

import logging
import time

from . import config, db
from .confluence import ConfluenceResult, compute_confluence
from .db import HistoryContext
from .models import AssetMarket, Criterion, Severity

logger = logging.getLogger(__name__)


class _CycleWriter:
    """Accumule les écritures d'alertes d'un cycle et les applique en lot.

    `active` est l'état des alertes actives au début du cycle : il sert de
    source de vérité pour la règle « une seule alerte active par couple », en
    lieu et place d'un SELECT par couple évalué.
    """

    def __init__(self, active: dict[tuple[str, str], dict], ts: int) -> None:
        self._active = active
        self._ts = ts
        self._inserts: list[tuple] = []
        self._resolves: list[tuple[str, str]] = []
        self._confluence_updates: list[tuple] = []

    def has_active(self, coin: str, criterion: Criterion) -> dict | None:
        return self._active.get((coin, criterion.value))

    def create(
        self,
        coin: str,
        criterion: Criterion,
        severity: Severity,
        message: str,
        details: dict,
        score: float | None = None,
        direction: str | None = None,
    ) -> None:
        """Crée une alerte si aucune active n'existe pour ce couple."""
        if self.has_active(coin, criterion) is not None:
            # Une alerte active existe déjà : pas de nouvelle alerte (anti-bruit).
            return
        self._inserts.append(
            (coin, self._ts, criterion.value, severity.value, message, details, score, direction)
        )
        logger.info("ALERT [%s] %s %s — %s", severity.value.upper(), coin, criterion.value, message)

    def resolve(self, coin: str, criterion: Criterion, reason: str) -> None:
        """Si une alerte active existe et que la condition est revenue à la
        normale, on la marque résolue."""
        existing = self.has_active(coin, criterion)
        if existing is None:
            return
        self._resolves.append((coin, criterion.value))
        logger.info("RESOLVED %s %s — %s (id=%s)", coin, criterion.value, reason, existing["id"])

    def refresh_confluence(
        self,
        coin: str,
        score: float,
        direction: str,
        message: str,
        severity: Severity,
        details: dict,
    ) -> None:
        self._confluence_updates.append(
            (coin, Criterion.CONFLUENCE.value, score, direction, message, severity.value, details)
        )

    def flush(self) -> None:
        # Résolutions d'abord : un couple résolu ce cycle libère la place pour
        # une éventuelle réinsertion, et l'index unique partiel refuserait les
        # deux lignes actives simultanément.
        db.resolve_alerts_bulk(self._resolves, self._ts)
        db.update_confluence_alerts_bulk(self._confluence_updates)
        db.insert_alerts_bulk(self._inserts)


def _severity_from_thresholds(threshold_warn: float, threshold_crit: float, value: float) -> Severity | None:
    av = abs(value)
    if av >= threshold_crit:
        return Severity.CRITICAL
    if av >= threshold_warn:
        return Severity.WARNING
    return None


# --- Critère 1 : Funding rate ------------------------------------------------
def evaluate_funding(asset: AssetMarket, w: _CycleWriter) -> None:
    funding = asset.funding
    severity = _severity_from_thresholds(
        config.FUNDING_THRESHOLD_WARN, config.FUNDING_THRESHOLD_CRIT, funding
    )
    if severity is None:
        w.resolve(asset.coin, Criterion.FUNDING_RATE, "funding revenu sous le seuil")
        return
    direction = "positif (longs paient)" if funding > 0 else "négatif (shorts paient)"
    pct = funding * 100
    message = f"{asset.coin} funding {direction}: {pct:+.4f}%"
    w.create(
        asset.coin,
        Criterion.FUNDING_RATE,
        severity,
        message,
        {"funding": funding, "funding_pct": pct},
    )


# --- Critère 2 : Pic d'Open Interest ----------------------------------------
def evaluate_open_interest(asset: AssetMarket, ctx: HistoryContext, w: _CycleWriter) -> None:
    prev = ctx.snapshot_at_oi_lookback(asset.coin)
    if prev is None or prev["open_interest"] <= 0:
        return
    delta_pct = (asset.open_interest - prev["open_interest"]) / prev["open_interest"]
    severity = _severity_from_thresholds(
        config.OI_PCT_THRESHOLD_WARN, config.OI_PCT_THRESHOLD_CRIT, delta_pct
    )
    if severity is None:
        w.resolve(asset.coin, Criterion.OPEN_INTEREST, "OI stabilisé")
        return
    direction = "hausse" if delta_pct > 0 else "baisse"
    message = f"{asset.coin} OI en {direction} de {delta_pct * 100:+.1f}% sur {config.OI_LOOKBACK_MIN}min"
    w.create(
        asset.coin,
        Criterion.OPEN_INTEREST,
        severity,
        message,
        {"oi_now": asset.open_interest, "oi_prev": prev["open_interest"], "delta_pct": delta_pct},
    )


# --- Critère 3 : Volume anormal (pic relatif) --------------------------------
def evaluate_volume(asset: AssetMarket, ctx: HistoryContext, w: _CycleWriter) -> None:
    """Détecte un pic du TAUX de volume (USD/sec de volume neuf) sur une fenêtre
    courte vs une baseline plus longue. Évite le spam sur BTC/ETH qui ont un
    fort volume cumulé 24h permanent."""
    recent_rate = ctx.volume_rate(asset.coin)
    baseline_rate = ctx.avg_volume_rate(asset.coin)

    # Pas assez d'historique pour évaluer
    if recent_rate is None or baseline_rate is None:
        return

    # Si le taux récent est faible (pas de pic), on résout toute alerte active.
    if recent_rate < config.VOLUME_MIN_RATE_USDPS:
        w.resolve(asset.coin, Criterion.VOLUME, "volume revenu sous le plancher")
        return

    # La baseline peut être négative (le volume cumulé 24h décroît naturellement
    # quand les vieilles transactions sortent de la fenêtre 24h). On ne peut pas
    # calculer un multiple dans ce cas — on compare donc à un seuil absolu de
    # "pic" (en USD/sec) dérivé du plancher multiplié par un facteur conservateur.
    if baseline_rate <= config.VOLUME_MIN_RATE_USDPS:
        # Baseline faible/nulle : pic si le taux récent dépasse un seuil élevé.
        # On utilise le multiple des seuils appliqué au plancher.
        threshold_warn = config.VOLUME_MIN_RATE_USDPS * config.VOLUME_SPIKE_MULT_WARN
        threshold_crit = config.VOLUME_MIN_RATE_USDPS * config.VOLUME_SPIKE_MULT_CRIT
        sev = _severity_from_thresholds(threshold_warn, threshold_crit, recent_rate)
        if sev is None:
            w.resolve(asset.coin, Criterion.VOLUME, "volume revenu à la normale")
            return
        message = (
            f"{asset.coin} pic de volume (${recent_rate / 1000:.0f}k/s sur "
            f"{config.VOLUME_RECENT_MIN}min)"
        )
        w.create(
            asset.coin,
            Criterion.VOLUME,
            sev,
            message,
            {"recent_rate_usdps": recent_rate, "baseline_rate_usdps": baseline_rate, "mode": "absolute"},
        )
        return

    # Baseline positive : multiple classique.
    mult = recent_rate / baseline_rate
    severity = _severity_from_thresholds(
        config.VOLUME_SPIKE_MULT_WARN,
        config.VOLUME_SPIKE_MULT_CRIT,
        mult,
    )
    if severity is None:
        w.resolve(asset.coin, Criterion.VOLUME, "volume revenu à la normale")
        return
    message = (
        f"{asset.coin} volume {mult:.1f}x la normale "
        f"(${recent_rate / 1000:.0f}k/s sur {config.VOLUME_RECENT_MIN}min)"
    )
    w.create(
        asset.coin,
        Criterion.VOLUME,
        severity,
        message,
        {"recent_rate_usdps": recent_rate, "baseline_rate_usdps": baseline_rate, "multiple": mult},
    )


# --- Critère 4 : Variation de prix -------------------------------------------
def evaluate_price_change(asset: AssetMarket, ctx: HistoryContext, w: _CycleWriter) -> None:
    prev = ctx.snapshot_at_price_lookback(asset.coin)
    if prev is None or prev["mark_px"] <= 0:
        return
    delta_pct = (asset.mark_px - prev["mark_px"]) / prev["mark_px"]
    severity = _severity_from_thresholds(
        config.PRICE_PCT_THRESHOLD_WARN, config.PRICE_PCT_THRESHOLD_CRIT, delta_pct
    )
    if severity is None:
        w.resolve(asset.coin, Criterion.PRICE_CHANGE, "prix stabilisé")
        return
    direction = "hausse" if delta_pct > 0 else "baisse"
    message = f"{asset.coin} {direction} de {delta_pct * 100:+.2f}% sur {config.PRICE_LOOKBACK_MIN}min"
    w.create(
        asset.coin,
        Criterion.PRICE_CHANGE,
        severity,
        message,
        {"px_now": asset.mark_px, "px_prev": prev["mark_px"], "delta_pct": delta_pct},
    )


# --- Critère 5 : Confluence --------------------------------------------------
def evaluate_confluence(result: ConfluenceResult, w: _CycleWriter) -> None:
    """Crée une alerte si ≥ CONFLUENCE_MIN_CRITERIA critères sont actifs ET le
    score agrégé dépasse CONFLUENCE_SCORE_WARN. Comme le score évolue à chaque
    cycle, on met à jour l'alerte active (score/direction/message) plutôt que
    d'en créer une nouvelle.

    Le régime (prix×OI) est central dans l'interprétation :
    - strong_bull / strong_bear  → SOLIDE, sévérité pleine
    - short_covering / exhaustion → FRAGILE, dégradé à INFO (rebond éphémère)
    On n'alerte pas sur un régime 'none' (pas de croisement significatif).
    """
    score = result.score
    active_count = result.active_count
    regime = result.regime

    # Pas de régime identifiable → pas d'alerte de confluence
    if regime == "none":
        w.resolve(result.coin, Criterion.CONFLUENCE, "pas de régime prix×OI")
        return

    # Conditions de déclenchement : assez de critères actifs + amplitude suffisante
    if active_count < config.CONFLUENCE_MIN_CRITERIA or abs(score) < config.CONFLUENCE_SCORE_WARN:
        w.resolve(result.coin, Criterion.CONFLUENCE, "confluence revenue sous le seuil")
        return

    # Sévérité selon l'amplitude du score ET la fiabilité du régime.
    # Les régimes fragiles (covering/exhaustion) sont plafonnés à WARNING.
    amp_critical = abs(score) >= config.CONFLUENCE_SCORE_CRIT
    is_solid = result.confidence >= 0.8
    if amp_critical and is_solid:
        severity = Severity.CRITICAL
    elif is_solid or amp_critical:
        severity = Severity.WARNING
    else:
        severity = Severity.INFO  # régime fragile, à surveiller

    arrow = "▲" if result.direction == "bullish" else "▼" if result.direction == "bearish" else "●"
    active_labels = [s.label for s in result.breakdown if s.active]
    vol_marker = " +Vol✓" if result.volume_confirmed else " (vol faible)"
    message = (
        f"{result.coin} {arrow} {result.regime_label} (score {score:+.1f}{vol_marker}, "
        f"{active_count} critères: {', '.join(active_labels)})"
    )
    details = {
        "score": score,
        "active_count": active_count,
        "regime": regime,
        "regime_label": result.regime_label,
        "confidence": result.confidence,
        "volume_confirmed": result.volume_confirmed,
        "breakdown": [
            {
                "criterion": s.criterion.value,
                "score": s.score,
                "direction": s.direction,
                "label": s.label,
                "value": s.value,
            }
            for s in result.breakdown
        ],
    }

    # Si une alerte de confluence active existe déjà, on la met à jour
    # (le score évolue en continu) ; sinon on en crée une nouvelle.
    if w.has_active(result.coin, Criterion.CONFLUENCE) is not None:
        w.refresh_confluence(result.coin, score, result.direction, message, severity, details)
    else:
        w.create(
            result.coin,
            Criterion.CONFLUENCE,
            severity,
            message,
            details,
            score=score,
            direction=result.direction,
        )


def evaluate_all(assets: list[AssetMarket], ctx: HistoryContext) -> tuple[int, int]:
    """Évalue tous les critères. Retourne (alertes_actives_après, _avant)."""
    active = db.get_active_alerts_map()
    before_active = len(active)
    writer = _CycleWriter(active, int(time.time() * 1000))

    # Étape 1 : critères individuels
    for asset in assets:
        try:
            evaluate_funding(asset, writer)
            evaluate_open_interest(asset, ctx, writer)
            evaluate_volume(asset, ctx, writer)
            evaluate_price_change(asset, ctx, writer)
        except Exception:
            logger.exception("Erreur évaluation alertes pour %s", asset.coin)

    # Étape 2 : score de confluence par coin (agrégation directionnelle)
    confluence_results: list[ConfluenceResult] = []
    for asset in assets:
        try:
            result = compute_confluence(asset, ctx)
            confluence_results.append(result)
            evaluate_confluence(result, writer)
        except Exception:
            logger.exception("Erreur confluence pour %s", asset.coin)

    writer.flush()

    # Publie les scores pour la route /api/confluence
    from . import confluence_cache

    confluence_cache.set_confluence_scores(ctx.now_ms, confluence_results)

    after_active = db.count_active_alerts()
    return after_active, before_active
