"""Score de confluence multi-critères directionnel — v2 (régimes).

Implémente les règles d'interprétation classiques du croisement Prix × OI,
affinées par le volume et le funding :

  Prix ↑ + Vol ↑ + OI ↑ → tendance haussière SOLIDE (nouveaux acheteurs)
  Prix ↑ + Vol ↑ + OI ↓ → haussière fragile / short covering (rebond éphémère)
  Prix ↓ + Vol ↑ + OI ↑ → tendance baissière SOLIDE (nouveaux shorts)
  Prix ↓ + Vol ↑ + OI ↓ → épuisement / couverture de shorts → possible rebond

Le « régime » (combinaison prix × OI) détermine la DIRECTION et la fiabilité.
Le volume amplifie l'amplitude (confirmation) mais ne change pas la direction.
Le funding est un signal secondaire qui peut confirmer ou contredire.

Détails importants :
- On utilise le DELTA d'OI (variation sur la fenêtre), pas le niveau absolu.
- Un croisement isolé n'est pas fiable : il faut aussi du volume (confirmation).
- Sans volume, le signal est dégradé (peu fiable).
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field

from . import config
from .db import HistoryContext
from .models import AssetMarket, Criterion

logger = logging.getLogger(__name__)


# --- Régimes (matrice Prix × OI) --------------------------------------------
# Encodage de l'interprétation trading du croisement prix/OI.
# Les clés sont (direction_prix, direction_OI) ∈ {+1, -1}.

@dataclass(frozen=True)
class Regime:
    key: str
    label: str
    direction: str       # "bullish" | "bearish" | "neutral"
    confidence: float    # facteur de fiabilité ∈ [0, 1] appliqué au score
    description: str


_REGIMES: dict[tuple[int, int], Regime] = {
    # Prix ↑ + OI ↑ : nouveaux acheteurs → SOLIDE haussier
    (+1, +1): Regime("strong_bull", "Haussier solide", "bullish", 1.0,
                     "Nouveaux acheteurs entrent (prix↑ + OI↑)"),
    # Prix ↑ + OI ↓ : short covering → haussier fragile
    (+1, -1): Regime("short_covering", "Short covering", "bullish", 0.4,
                     "Prix↑ mais positions fermées (short covering) — fragile"),
    # Prix ↓ + OI ↑ : nouveaux shorts → SOLIDE baissier
    (-1, +1): Regime("strong_bear", "Baissier solide", "bearish", 1.0,
                     "Nouveaux shorts entrent (prix↓ + OI↑)"),
    # Prix ↓ + OI ↓ : couverture/épuisement → possible rebond (faiblement haussier)
    (-1, -1): Regime("exhaustion", "Épuisement", "neutral", 0.3,
                     "Prix↓ + OI↓ : couverture de shorts, possible rebond"),
}


def _regime_for(price_dir: int, oi_dir: int) -> Regime | None:
    """Retourne le régime pour une direction prix/OI donnée.

    Renvoie None si l'une des directions est nulle (pas de mouvement
    significatif sur le prix ou l'OI) — on ne peut pas déterminer un régime.
    """
    if price_dir == 0 or oi_dir == 0:
        return None
    return _REGIMES.get((price_dir, oi_dir))


@dataclass
class SignalScore:
    criterion: Criterion
    score: float          # ∈ [-1, +1], 0 si inactif
    direction: str        # "bullish" | "bearish" | "neutral"
    value: float          # métrique brute
    active: bool
    label: str


@dataclass
class ConfluenceResult:
    coin: str
    score: float                 # ∈ [-10, +10], avec signe = direction du régime
    direction: str               # "bullish" | "bearish" | "neutral"
    active_count: int
    regime: str                  # clé du régime (ex: "strong_bull")
    regime_label: str            # libellé lisible
    confidence: float            # fiabilité ∈ [0, 1]
    volume_confirmed: bool       # True si le volume confirme (signal plus fiable)
    breakdown: list[SignalScore] = field(default_factory=list)


def _direction(sign: float) -> str:
    if sign > 1e-9:
        return "bullish"
    if sign < -1e-9:
        return "bearish"
    return "neutral"


def _amplitude(value: float, warn: float, crit: float) -> float:
    """Interpole |value| entre warn (→0) et crit (→1), plafonné. 0 si < warn."""
    av = abs(value)
    if av < warn:
        return 0.0
    if av >= crit:
        return 1.0
    return (av - warn) / (crit - warn)


def _sign_dir(v: float) -> int:
    """Direction entière : +1, -1, ou 0 si nul."""
    if v > 1e-9:
        return +1
    if v < -1e-9:
        return -1
    return 0


# --- Calcul par critère (pur, sans side-effect) ------------------------------
def signal_funding(asset: AssetMarket) -> SignalScore:
    funding = asset.funding
    amp = _amplitude(funding, config.FUNDING_THRESHOLD_WARN, config.FUNDING_THRESHOLD_CRIT)
    signed = amp if funding >= 0 else -amp
    pct = funding * 100
    return SignalScore(
        criterion=Criterion.FUNDING_RATE,
        score=signed,
        direction=_direction(signed),
        value=funding,
        active=amp > 0,
        label=f"Funding {pct:+.4f}%",
    )


def signal_open_interest(asset: AssetMarket, ctx: HistoryContext) -> SignalScore:
    prev = ctx.snapshot_at_oi_lookback(asset.coin)
    if prev is None or prev.get("open_interest", 0) <= 0:
        return SignalScore(Criterion.OPEN_INTEREST, 0.0, "neutral", 0.0, False, "OI n/a")
    delta_pct = (asset.open_interest - prev["open_interest"]) / prev["open_interest"]
    amp = _amplitude(delta_pct, config.OI_PCT_THRESHOLD_WARN, config.OI_PCT_THRESHOLD_CRIT)
    signed = amp if delta_pct >= 0 else -amp
    return SignalScore(
        criterion=Criterion.OPEN_INTEREST,
        score=signed,
        direction=_direction(signed),
        value=delta_pct,
        active=amp > 0,
        label=f"OI {delta_pct * 100:+.1f}%/{config.OI_LOOKBACK_MIN}min",
    )


def signal_volume(asset: AssetMarket, ctx: HistoryContext) -> SignalScore:
    """Volume = confirmation. Toujours >= 0 (neutre en direction)."""
    recent_rate = ctx.volume_rate(asset.coin)
    baseline_rate = ctx.avg_volume_rate(asset.coin)
    if recent_rate is None or baseline_rate is None:
        return SignalScore(Criterion.VOLUME, 0.0, "neutral", 0.0, False, "Volume n/a")

    if recent_rate < config.VOLUME_MIN_RATE_USDPS:
        return SignalScore(Criterion.VOLUME, 0.0, "neutral", recent_rate, False, "Volume faible")

    if baseline_rate <= config.VOLUME_MIN_RATE_USDPS:
        threshold_warn = config.VOLUME_MIN_RATE_USDPS * config.VOLUME_SPIKE_MULT_WARN
        threshold_crit = config.VOLUME_MIN_RATE_USDPS * config.VOLUME_SPIKE_MULT_CRIT
        amp = _amplitude(recent_rate, threshold_warn, threshold_crit)
        return SignalScore(
            criterion=Criterion.VOLUME,
            score=amp,
            direction="neutral",
            value=recent_rate,
            active=amp > 0,
            label=f"Vol {recent_rate / 1000:.0f}k$/s",
        )

    mult = recent_rate / baseline_rate
    amp = _amplitude(mult, config.VOLUME_SPIKE_MULT_WARN, config.VOLUME_SPIKE_MULT_CRIT)
    return SignalScore(
        criterion=Criterion.VOLUME,
        score=amp,
        direction="neutral",
        value=mult,
        active=amp > 0,
        label=f"Vol {mult:.1f}x normale",
    )


def signal_price_change(asset: AssetMarket, ctx: HistoryContext) -> SignalScore:
    prev = ctx.snapshot_at_price_lookback(asset.coin)
    if prev is None or prev.get("mark_px", 0) <= 0:
        return SignalScore(Criterion.PRICE_CHANGE, 0.0, "neutral", 0.0, False, "Prix n/a")
    delta_pct = (asset.mark_px - prev["mark_px"]) / prev["mark_px"]
    amp = _amplitude(delta_pct, config.PRICE_PCT_THRESHOLD_WARN, config.PRICE_PCT_THRESHOLD_CRIT)
    signed = amp if delta_pct >= 0 else -amp
    return SignalScore(
        criterion=Criterion.PRICE_CHANGE,
        score=signed,
        direction=_direction(signed),
        value=delta_pct,
        active=amp > 0,
        label=f"Prix {delta_pct * 100:+.2f}%/{config.PRICE_LOOKBACK_MIN}min",
    )


# --- Agrégation v2 : matrice de régimes -------------------------------------
def compute_confluence(asset: AssetMarket, ctx: HistoryContext) -> ConfluenceResult:
    price_sig = signal_price_change(asset, ctx)
    vol_sig = signal_volume(asset, ctx)
    oi_sig = signal_open_interest(asset, ctx)
    fund_sig = signal_funding(asset)
    breakdown = [price_sig, vol_sig, oi_sig, fund_sig]

    # Directions entières pour la matrice de régime (uniquement si le critère
    # est actif — sous le seuil, on considère qu'il n'y a pas de mouvement).
    price_dir = _sign_dir(price_sig.score)
    oi_dir = _sign_dir(oi_sig.score)
    regime = _regime_for(price_dir, oi_dir)

    active_count = sum(1 for s in breakdown if s.active)
    volume_confirmed = vol_sig.active

    # Cas sans régime identifiable (prix ou OI sous seuil) : pas de signal fort.
    if regime is None:
        return ConfluenceResult(
            coin=asset.coin,
            score=0.0,
            direction="neutral",
            active_count=active_count,
            regime="none",
            regime_label="Pas de régime",
            confidence=0.0,
            volume_confirmed=volume_confirmed,
            breakdown=breakdown,
        )

    # Amplitude de base = moyenne des amplitudes prix + OI (les deux moteurs du régime)
    base_amp = (abs(price_sig.score) + abs(oi_sig.score)) / 2.0

    # Le volume AMPLIFIE le signal (jusqu'à +50%) : un régime sans volume est
    # moins fiable, un régime avec volume explosif est renforcé.
    vol_mult = 1.0 + 0.5 * vol_sig.score  # vol_sig.score ∈ [0, 1]

    # Le funding peut confirmer (+) ou contredire (−) le régime :
    # - funding > 0 confirme un régime haussier, affaiblit un baissier
    # - funding < 0 confirme un régime baissier, affaiblit un haussier
    fund_confirm = 0.0
    if fund_sig.active:
        if regime.direction == "bullish":
            fund_confirm = 0.3 * fund_sig.score   # positif si funding haussier
        elif regime.direction == "bearish":
            fund_confirm = -0.3 * fund_sig.score  # positif si funding baissier (neg*neg)
        # régime neutre : le funding n'a pas de sens directionnel, ignoré

    # Score brut ∈ [0, ~1.8] puis normalisé sur l'échelle [-10, +10]
    raw_score = base_amp * vol_mult + fund_confirm
    # Applique le signe du régime et la confiance (fiabilité du pattern)
    signed_score = raw_score * regime.confidence
    if regime.direction == "bearish":
        signed_score = -signed_score
    # neutre (exhaustion) → léger biais haussier (rebond possible)
    if regime.direction == "neutral":
        signed_score = abs(signed_score) * 0.3  # petit score positif (signal de rebond)

    # Mise à l'échelle [-10, +10] : raw_score max théorique ≈ 1*1.5 + 0.3 = 1.8
    MAX_RAW = 1.8
    score = (signed_score / MAX_RAW) * 10.0
    score = max(-10.0, min(10.0, score))

    return ConfluenceResult(
        coin=asset.coin,
        score=round(score, 2),
        direction=regime.direction,
        active_count=active_count,
        regime=regime.key,
        regime_label=regime.label,
        confidence=regime.confidence,
        volume_confirmed=volume_confirmed,
        breakdown=breakdown,
    )


def compute_all(assets: list[AssetMarket], ctx: HistoryContext) -> list[ConfluenceResult]:
    results: list[ConfluenceResult] = []
    for asset in assets:
        try:
            results.append(compute_confluence(asset, ctx))
        except Exception:
            logger.exception("Erreur confluence pour %s", asset.coin)
    return results
