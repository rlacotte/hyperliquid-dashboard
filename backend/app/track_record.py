"""Track record des alertes : ce qui s'est réellement passé après chacune.

La veille l'a relevé comme le manque principal du marché : les outils vendent des
signaux sans jamais publier ce qu'ils valent. On mesure donc, pour chaque alerte
émise, le rendement du coin à 1 h, 4 h et 24 h.

Trois choix de rigueur :

1. Source : les bougies Hyperliquid (15 min), et non nos propres snapshots.
   Notre collecte a eu ~6 % de couverture jusqu'en novembre 2026 ; les bougies,
   elles, sont complètes côté exchange. Le track record ne dépend donc pas de
   nos trous de collecte.

2. Pas de regard vers le futur : le prix de référence est l'OUVERTURE de la
   première bougie qui commence après l'alerte — le prix auquel on aurait pu
   agir en la recevant. Idem pour chaque horizon.

3. Comparaison au BTC : un jour où tout le marché baisse de 8 %, tous les
   signaux « baissiers » paraissent excellents. Le rendement relatif au BTC
   sur la même fenêtre isole ce que le signal apporte au-delà du marché.

Coût maîtrisé : une alerte n'est recalculée que lorsqu'un nouvel horizon arrive
à maturité (au plus 3 fois), et chaque passe est bornée en nombre de coins.
"""
from __future__ import annotations

import logging
import statistics
import time
from bisect import bisect_left
from typing import Any

from . import db

logger = logging.getLogger(__name__)

HORIZONS_H = (1, 4, 24)

# Double résolution, imposée par l'API : Hyperliquid ne sert que les 5 000
# dernières bougies. Vérifié en direct : en 15 min, aucune bougie au-delà de
# ~52 jours ; en 1 h, plus de 150 jours d'historique.
# - alertes récentes (< 50 j) : bougies de 15 min, tous les horizons ;
# - alertes plus anciennes : bougies d'1 h, SANS l'horizon 1 h — avec jusqu'à
#   60 min d'écart sur le prix d'entrée, une mesure à 1 h serait fausse.
FINE = {"interval": "15m", "ms": 15 * 60 * 1000, "horizons": HORIZONS_H}
COARSE = {"interval": "1h", "ms": 60 * 60 * 1000, "horizons": (4, 24)}
FINE_MAX_AGE_MS = 50 * 86400_000
CANDLE_MS = FINE["ms"]  # résolution de référence (tests, marges)
TAIL_MS = max(HORIZONS_H) * 3600_000 + COARSE["ms"]
COINS_PER_PASS = 3
PASS_EVERY_SEC = 120
LOOKBACK_DAYS = 200  # bougies d'1 h : ~208 jours disponibles
MARKET = "BTC"
_PASS_KEY = "track_record_pass"


# --- Calcul pur --------------------------------------------------------------
def signal_sign(criterion: str, details: dict | None, direction: str | None) -> int:
    """Sens de l'alerte : +1 (hausse / positif), −1, ou 0 (sans sens).

    - price_change, open_interest : signe de la variation mesurée ;
    - funding_rate : signe du funding (+ = les longs paient) ;
    - confluence : direction du régime ;
    - volume : un pic de volume n'a pas de sens → 0.
    """
    d = details or {}
    if criterion in ("price_change", "open_interest"):
        v = d.get("delta_pct")
    elif criterion == "funding_rate":
        v = d.get("funding")
    elif criterion == "confluence":
        return {"bullish": 1, "bearish": -1}.get(direction or "", 0)
    else:
        return 0
    try:
        v = float(v)
    except (TypeError, ValueError):
        return 0
    return 1 if v > 0 else -1 if v < 0 else 0


def open_after(candles: list[tuple[int, float]], t_ms: int, candle_ms: int = CANDLE_MS) -> float | None:
    """Ouverture de la première bougie commençant à t_ms ou après.

    `candles` : [(t_ouverture, prix_ouverture)] trié. None si aucune bougie ne
    commence après t_ms (horizon pas encore atteint, ou hors de la plage).
    """
    i = bisect_left(candles, t_ms, key=lambda c: c[0])
    if i >= len(candles):
        return None
    t, px = candles[i]
    # Garde-fou : une bougie très éloignée signale un trou (marché délisté,
    # pause) — mieux vaut pas de mesure qu'une mesure fausse.
    if t - t_ms > 2 * candle_ms:
        return None
    return px if px > 0 else None


def outcome(candles: list[tuple[int, float]], market: list[tuple[int, float]], ts: int, res: dict = FINE) -> dict:
    """Rendements du coin et du marché aux horizons mesurables à cette résolution."""
    cms = res["ms"]
    out: dict[str, Any] = {"px0": None, "resolution_min": cms // 60_000}
    p0 = open_after(candles, ts, cms)
    m0 = open_after(market, ts, cms)
    out["px0"] = p0
    for h in HORIZONS_H:
        if h not in res["horizons"]:
            out[f"ret_{h}h"] = out[f"btc_{h}h"] = None
            continue
        t = ts + h * 3600_000
        ph = open_after(candles, t, cms) if p0 else None
        mh = open_after(market, t, cms) if m0 else None
        out[f"ret_{h}h"] = (ph / p0 - 1) if (p0 and ph) else None
        out[f"btc_{h}h"] = (mh / m0 - 1) if (m0 and mh) else None
    out["complete"] = out[f"ret_{max(HORIZONS_H)}h"] is not None
    return out


def resolution_for(ts: int, now_ms: int) -> dict:
    return FINE if now_ms - ts < FINE_MAX_AGE_MS else COARSE


def aggregate(rows: list[dict]) -> list[dict]:
    """Statistiques par (critère, sens) et par horizon.

    Pour chaque groupe : effectif, part des hausses, rendement moyen et médian,
    rendement moyen RELATIF au BTC, et part des cas où le coin a fait mieux que
    le BTC. On n'impose pas de thèse (« un funding positif est baissier ») : on
    montre ce qui s'est passé, à l'interface de le traduire en langage clair.
    """
    groups: dict[tuple[str, int], list[dict]] = {}
    for r in rows:
        groups.setdefault((r["criterion"], r["sign"]), []).append(r)

    out = []
    for (criterion, sign), items in sorted(groups.items()):
        horizons = {}
        for h in HORIZONS_H:
            rets = [r[f"ret_{h}h"] for r in items if r.get(f"ret_{h}h") is not None]
            pairs = [
                (r[f"ret_{h}h"], r[f"btc_{h}h"])
                for r in items
                if r.get(f"ret_{h}h") is not None and r.get(f"btc_{h}h") is not None and r["coin"] != MARKET
            ]
            if not rets:
                horizons[f"{h}h"] = {"n": 0}
                continue
            excess = [a - b for a, b in pairs]
            horizons[f"{h}h"] = {
                "n": len(rets),
                "p_up": round(sum(1 for x in rets if x > 0) / len(rets), 4),
                "mean": round(statistics.fmean(rets), 6),
                "median": round(statistics.median(rets), 6),
                "n_vs_btc": len(excess),
                "mean_vs_btc": round(statistics.fmean(excess), 6) if excess else None,
                "p_beat_btc": round(sum(1 for x in excess if x > 0) / len(excess), 4) if excess else None,
            }
        out.append({
            "criterion": criterion,
            "sign": sign,
            "alerts": len(items),
            "coins": len({r["coin"] for r in items}),
            "horizons": horizons,
        })
    return out


# --- Orchestration (appelée par le cycle de collecte) ---------------------------
async def maybe_process(client, now_ms: int | None = None) -> dict | None:
    """Calcule les résultats d'un petit lot d'alertes, au plus toutes les 2 min."""
    now_ms = now_ms or int(time.time() * 1000)
    if not db.try_claim(_PASS_KEY, now_ms, PASS_EVERY_SEC * 1000):
        return None

    pending = db.pending_alert_outcomes(now_ms, [h * 3600_000 + COARSE["ms"] for h in HORIZONS_H], LOOKBACK_DAYS)
    if not pending:
        return {"processed": 0}

    by_coin: dict[str, list[dict]] = {}
    for p in pending:
        by_coin.setdefault(p["coin"], []).append(p)
    coins = sorted(by_coin, key=lambda c: min(p["ts"] for p in by_coin[c]))[:COINS_PER_PASS]

    # Une requête de bougies par (coin, résolution) ; le marché une fois par
    # résolution, sur l'union des plages du lot.
    groups: dict[tuple[str, str], list[dict]] = {}
    for coin in coins:
        for p in by_coin[coin]:
            groups.setdefault((coin, resolution_for(p["ts"], now_ms)["interval"]), []).append(p)

    res_by_interval = {FINE["interval"]: FINE, COARSE["interval"]: COARSE}
    ranges: dict[str, tuple[int, int]] = {}
    for (_, interval), items in groups.items():
        cms = res_by_interval[interval]["ms"]
        lo = min(p["ts"] for p in items) - cms
        hi = min(max(p["ts"] for p in items) + TAIL_MS, now_ms)
        cur = ranges.get(interval)
        ranges[interval] = (min(lo, cur[0]), max(hi, cur[1])) if cur else (lo, hi)
    market = {iv: await _candles(client, MARKET, iv, lo, hi) for iv, (lo, hi) in ranges.items()}

    results = []
    for (coin, interval), items in groups.items():
        res = res_by_interval[interval]
        lo, hi = ranges[interval]
        candles = market[interval] if coin == MARKET else await _candles(client, coin, interval, lo, hi)
        for p in items:
            results.append({**p, **outcome(candles, market[interval], p["ts"], res)})

    db.upsert_alert_outcomes(results, now_ms)
    logger.info("Track record : %d alertes sur %s", len(results), ",".join(coins))
    return {"processed": len(results), "coins": coins, "pending": len(pending)}


async def _candles(client, coin: str, interval: str, lo: int, hi: int) -> list[tuple[int, float]]:
    raw = await client.get_candles(coin, interval, lo, hi)
    return sorted((int(c["t"]), float(c["o"])) for c in raw if c.get("o") is not None)


def summary() -> dict:
    rows = db.alert_outcomes_rows(LOOKBACK_DAYS)
    return {"groups": aggregate(rows), "outcomes": len(rows), "horizons_h": list(HORIZONS_H), "lookback_days": LOOKBACK_DAYS}
