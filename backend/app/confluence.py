"""Score de confluence multi-critères directionnel.

Pour chaque coin, chaque critère (prix, volume, OI, funding) produit un score
signé ∈ [-1, +1] :
- Signe = direction (haussier=+, baissier=−)
- Amplitude = 0 sous le seuil warn, interpolation linéaire jusqu'au seuil crit
  où le score atteint ±1, plafonné au-delà.

Le score agrégé = Σ (poids × score_critère) ∈ [-10, +10]. La confluence est
forte quand ≥ CONFLUENCE_MIN_CRITERIA critères sont actifs ET tirent dans le
même sens (le signe global cohérent).

Réutilise les mêmes calculs de delta (OI, prix) et de taux (volume) que
alert_engine, mais sans créer d'alertes — pur calcul.

L'historique n'est plus interrogé coin par coin : il arrive pré-chargé dans un
HistoryContext (cf. db.load_history_context), ce qui rend ce module purement
calculatoire et testable sans base.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field

from . import config
from .db import HistoryContext
from .models import AssetMarket, Criterion

logger = logging.getLogger(__name__)


@dataclass
class SignalScore:
    criterion: Criterion
    score: float          # ∈ [-1, +1], 0 si inactif
    direction: str        # "bullish" | "bearish" | "neutral"
    value: float          # métrique brute (delta_pct, funding, mult, etc.)
    active: bool          # True si |score| > 0
    label: str            # description courte pour l'UI


@dataclass
class ConfluenceResult:
    coin: str
    score: float                 # ∈ [-10, +10]
    direction: str               # "bullish" | "bearish" | "neutral"
    active_count: int            # nb de critères actifs
    breakdown: list[SignalScore] = field(default_factory=list)


def _direction(sign: float) -> str:
    if sign > 1e-9:
        return "bullish"
    if sign < -1e-9:
        return "bearish"
    return "neutral"


def _amplitude(value: float, warn: float, crit: float) -> float:
    """Interpole linéairement |value| entre warn (→0) et crit (→1), plafonné.

    Renvoie 0 si |value| < warn, 1 si |value| >= crit.
    """
    av = abs(value)
    if av < warn:
        return 0.0
    if av >= crit:
        return 1.0
    # interpolation linéaire entre warn et crit
    return (av - warn) / (crit - warn)


# --- Calcul par critère (pur, sans side-effect) ------------------------------
def signal_funding(asset: AssetMarket) -> SignalScore:
    funding = asset.funding
    amp = _amplitude(funding, config.FUNDING_THRESHOLD_WARN, config.FUNDING_THRESHOLD_CRIT)
    # Funding > 0 = longs paient = sentiment haussier (prix poussé à la hausse)
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
    if prev is None or prev["open_interest"] <= 0:
        return SignalScore(Criterion.OPEN_INTEREST, 0.0, "neutral", 0.0, False, "OI n/a")
    delta_pct = (asset.open_interest - prev["open_interest"]) / prev["open_interest"]
    amp = _amplitude(delta_pct, config.OI_PCT_THRESHOLD_WARN, config.OI_PCT_THRESHOLD_CRIT)
    # OI qui monte = capitaux entrants = direction du mouvement confirmée.
    # On garde le signe de delta_pct (haussier si OI monte, baissier si baisse).
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
    """Le volume confirme le mouvement, peu importe le sens. Score toujours >= 0."""
    recent_rate = ctx.volume_rate(asset.coin)
    baseline_rate = ctx.avg_volume_rate(asset.coin)
    if recent_rate is None or baseline_rate is None:
        return SignalScore(Criterion.VOLUME, 0.0, "neutral", 0.0, False, "Volume n/a")

    if recent_rate < config.VOLUME_MIN_RATE_USDPS:
        return SignalScore(Criterion.VOLUME, 0.0, "neutral", recent_rate, False, "Volume faible")

    if baseline_rate <= config.VOLUME_MIN_RATE_USDPS:
        # Mode absolu (cf alert_engine.evaluate_volume)
        threshold_warn = config.VOLUME_MIN_RATE_USDPS * config.VOLUME_SPIKE_MULT_WARN
        threshold_crit = config.VOLUME_MIN_RATE_USDPS * config.VOLUME_SPIKE_MULT_CRIT
        amp = _amplitude(recent_rate, threshold_warn, threshold_crit)
        return SignalScore(
            criterion=Criterion.VOLUME,
            score=amp,  # neutre en direction, amplitude pure
            direction="neutral",
            value=recent_rate,
            active=amp > 0,
            label=f"Vol {recent_rate / 1000:.0f}k$/s",
        )

    mult = recent_rate / baseline_rate
    amp = _amplitude(mult, config.VOLUME_SPIKE_MULT_WARN, config.VOLUME_SPIKE_MULT_CRIT)
    return SignalScore(
        criterion=Criterion.VOLUME,
        score=amp,  # neutre en direction
        direction="neutral",
        value=mult,
        active=amp > 0,
        label=f"Vol {mult:.1f}x normale",
    )


def signal_price_change(asset: AssetMarket, ctx: HistoryContext) -> SignalScore:
    prev = ctx.snapshot_at_price_lookback(asset.coin)
    if prev is None or prev["mark_px"] <= 0:
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


# --- Agrégation --------------------------------------------------------------
_WEIGHTS: dict[Criterion, float] = {
    Criterion.PRICE_CHANGE: config.CONFLUENCE_WEIGHT_PRICE,
    Criterion.VOLUME: config.CONFLUENCE_WEIGHT_VOLUME,
    Criterion.OPEN_INTEREST: config.CONFLUENCE_WEIGHT_OI,
    Criterion.FUNDING_RATE: config.CONFLUENCE_WEIGHT_FUNDING,
}


def compute_confluence(asset: AssetMarket, ctx: HistoryContext) -> ConfluenceResult:
    breakdown = [
        signal_price_change(asset, ctx),
        signal_volume(asset, ctx),
        signal_open_interest(asset, ctx),
        signal_funding(asset),
    ]
    score = sum(_WEIGHTS[s.criterion] * s.score for s in breakdown)
    # Direction globale : signe du score agrégé. Le volume étant neutre, il ne
    # fait pencher ni d'un côté ni de l'autre, mais il amplifie l'amplitude.
    direction = _direction(score)
    active_count = sum(1 for s in breakdown if s.active)
    return ConfluenceResult(
        coin=asset.coin,
        score=round(score, 2),
        direction=direction,
        active_count=active_count,
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
