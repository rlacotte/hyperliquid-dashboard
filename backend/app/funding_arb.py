"""Arbitrage de funding Hyperliquid ↔ Binance ↔ Bybit : écarts et leur DURÉE.

Le scanner du navigateur montre l'écart à l'instant t. Ce qui manque pour
décider, c'est la mémoire : un écart de 60 %/an apparu il y a dix minutes est
souvent un artefact de période de financement, alors qu'un écart qui tient
depuis six heures est une opportunité. Ce module suit donc chaque écart dans le
temps (état en base, rafraîchi toutes les 5 min) et alimente le moteur
d'alertes, qui n'alerte que sur les écarts larges ET persistants.

Mêmes conventions que frontend/src/funding.ts : taux annualisés (Hyperliquid
paie toutes les heures, Binance/Bybit toutes les 4 ou 8 h), paire obligatoirement
avec Hyperliquid, short sur la plateforme au funding le plus élevé.
"""
from __future__ import annotations

import logging
import time
from typing import Any

from . import config, db

logger = logging.getLogger(__name__)

VENUES = ("HlPerp", "BinPerp", "BybitPerp")
VENUE_LABEL = {"HlPerp": "Hyperliquid", "BinPerp": "Binance", "BybitPerp": "Bybit"}
STATE_KEY = "funding_arb_state"
_PASS_KEY = "funding_arb_pass"


def annualize(rate: float, interval_hours: float) -> float:
    return (rate / interval_hours) * 24 * 365 if interval_hours > 0 else 0.0


def best_pair(rates: dict[str, float]) -> tuple[str, str, float] | None:
    """(venue à shorter, venue à acheter, écart APR) parmi les paires incluant
    Hyperliquid ; None si moins de deux plateformes."""
    if "HlPerp" not in rates:
        return None
    best: tuple[str, str, float] | None = None
    for other, apr in rates.items():
        if other == "HlPerp":
            continue
        hl = rates["HlPerp"]
        short, long_ = ("HlPerp", other) if hl >= apr else (other, "HlPerp")
        spread = abs(hl - apr)
        if best is None or spread > best[2]:
            best = (short, long_, spread)
    return best


def compute_spreads(raw: list) -> dict[str, dict[str, Any]]:
    """Réponse brute de predictedFundings → {coin: {short, long, spread_apr, aprs}}."""
    out: dict[str, dict[str, Any]] = {}
    for coin, venues in raw:
        aprs: dict[str, float] = {}
        for name, v in venues:
            if not v or name not in VENUES:
                continue
            try:
                aprs[name] = annualize(float(v["fundingRate"]), float(v["fundingIntervalHours"]))
            except (KeyError, TypeError, ValueError):
                continue
        pair = best_pair(aprs)
        if pair:
            out[coin] = {"short": pair[0], "long": pair[1], "spread_apr": pair[2], "aprs": aprs}
    return out


def update_state(prev: dict[str, dict], spreads: dict[str, dict], oi_usd: dict[str, float], now_ms: int) -> dict[str, dict]:
    """Nouvel état de suivi.

    Un écart est « continu » tant qu'il reste au-dessus du seuil de suivi AVEC
    LA MÊME PAIRE et sans trou de plus de deux passes. Un changement de sens
    (on shortait Binance, il faut maintenant shorter Hyperliquid) est un nouvel
    écart, pas la prolongation de l'ancien.
    """
    max_gap = 2 * config.ARB_REFRESH_SEC * 1000 + 60_000
    state: dict[str, dict] = {}
    for coin, s in spreads.items():
        if s["spread_apr"] < config.ARB_TRACK_MIN_APR or oi_usd.get(coin, 0.0) < config.ARB_MIN_OI_USD:
            continue
        p = prev.get(coin)
        continuous = p is not None and p["short"] == s["short"] and p["long"] == s["long"] and now_ms - p["last"] <= max_gap
        state[coin] = {
            "short": s["short"],
            "long": s["long"],
            "spread_apr": round(s["spread_apr"], 6),
            "since": p["since"] if continuous else now_ms,
            "max_apr": round(max(s["spread_apr"], p["max_apr"]) if continuous else s["spread_apr"], 6),
            "last": now_ms,
            "oi_usd": round(oi_usd.get(coin, 0.0), 2),
        }
    return state


async def maybe_refresh(client, crypto_assets: list, now_ms: int | None = None) -> dict | None:
    """Rafraîchit l'état au plus toutes les ARB_REFRESH_SEC (une requête)."""
    now_ms = now_ms or int(time.time() * 1000)
    if not db.try_claim(_PASS_KEY, now_ms, config.ARB_REFRESH_SEC * 1000):
        return None
    raw = await client.get_predicted_fundings()
    spreads = compute_spreads(raw)
    oi = {a.coin: a.open_interest_usd for a in crypto_assets}
    prev_stored = db.kv_get(STATE_KEY)
    prev = prev_stored[1].get("coins", {}) if prev_stored else {}
    state = update_state(prev, spreads, oi, now_ms)
    db.kv_set(STATE_KEY, now_ms, {"coins": state})
    return {"tracked": len(state)}


def current_state(now_ms: int | None = None) -> tuple[int, dict[str, dict]] | None:
    """(horodatage, état) si l'état est frais ; None s'il est périmé.

    Périmé = la récupération des taux échoue depuis plus de 3 passes : mieux
    vaut ne rien conclure que résoudre ou créer des alertes sur une vieille photo.
    """
    now_ms = now_ms or int(time.time() * 1000)
    stored = db.kv_get(STATE_KEY)
    if not stored or now_ms - stored[0] > 3 * config.ARB_REFRESH_SEC * 1000:
        return None
    return stored[0], stored[1].get("coins", {})
