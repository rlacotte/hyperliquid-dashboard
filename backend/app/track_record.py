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


def segment_of(coin: str) -> str:
    """crypto (DEX principal) ou hip3 (actions, indices, matières premières…).

    Référence de comparaison : le BTC pour les cryptos. Pour le HIP-3, aucune
    référence commune ne convient à la fois à TSLA, à l'or et à l'EUR : la
    mesure est en rendement BRUT, et c'est le témoin (jours ordinaires des
    mêmes marchés) qui dit si une alerte change quelque chose.
    """
    return "hip3" if ":" in coin else "crypto"


def _bench(market: list[tuple[int, float]] | None, t_ms: int, cms: int) -> float | None:
    """Prix de la référence ; sans référence (HIP-3), une constante : le
    rendement « relatif » devient alors le rendement brut."""
    return 1.0 if market is None else open_after(market, t_ms, cms)
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


def outcome(candles: list[tuple[int, float]], market: list[tuple[int, float]] | None, ts: int, res: dict = FINE) -> dict:
    """Rendements du coin et de la référence aux horizons mesurables à cette
    résolution. `market=None` : pas de référence (HIP-3), rendement brut."""
    cms = res["ms"]
    out: dict[str, Any] = {"px0": None, "resolution_min": cms // 60_000}
    p0 = open_after(candles, ts, cms)
    m0 = _bench(market, ts, cms)
    out["px0"] = p0
    for h in HORIZONS_H:
        if h not in res["horizons"]:
            out[f"ret_{h}h"] = out[f"btc_{h}h"] = None
            continue
        t = ts + h * 3600_000
        ph = open_after(candles, t, cms) if p0 else None
        mh = _bench(market, t, cms) if m0 else None
        out[f"ret_{h}h"] = (ph / p0 - 1) if (p0 and ph) else None
        out[f"btc_{h}h"] = (mh / m0 - 1) if (m0 and mh) else None
    out["complete"] = out[f"ret_{max(HORIZONS_H)}h"] is not None
    return out


DAY_MS = 86400_000


def baseline_from_candles(coin: str, candles: list[tuple[int, float]], market: list[tuple[int, float]] | None, res: dict) -> list[tuple[str, int, float]]:
    """Rendement à 24 h relatif au BTC pour chaque jour (00:00 UTC) couvert.

    C'est le TÉMOIN : sur la période, ces coins battent-ils le BTC d'habitude ?
    Sans lui, une sous-performance après alerte peut n'être que la faiblesse
    générale des altcoins (constaté : presque tous les types d'alertes
    « sous-performaient » le BTC, à la hausse comme à la baisse).
    """
    if not candles or (market is not None and (coin == MARKET or not market)):
        return []
    cms = res["ms"]
    first = (candles[0][0] // DAY_MS + 1) * DAY_MS
    last = candles[-1][0] - DAY_MS
    out = []
    t = first
    while t <= last:
        p0, p1 = open_after(candles, t, cms), open_after(candles, t + DAY_MS, cms)
        m0, m1 = _bench(market, t, cms), _bench(market, t + DAY_MS, cms)
        if p0 and p1 and m0 and m1:
            out.append((coin, t // DAY_MS, (p1 / p0 - 1) - (m1 / m0 - 1)))
        t += DAY_MS
    return out


def resolution_for(ts: int, now_ms: int) -> dict:
    return FINE if now_ms - ts < FINE_MAX_AGE_MS else COARSE


def aggregate(rows: list[dict], baseline: list[dict] | None = None) -> list[dict]:
    """Statistiques par (critère, sens) et par horizon.

    Pour chaque groupe : effectif, part des hausses, rendement moyen et médian,
    rendement moyen RELATIF au BTC, et part des cas où le coin a fait mieux que
    le BTC. On n'impose pas de thèse (« un funding positif est baissier ») : on
    montre ce qui s'est passé, à l'interface de le traduire en langage clair.
    """
    groups: dict[tuple[str, int, str], list[dict]] = {}
    for r in rows:
        groups.setdefault((r["criterion"], r["sign"], segment_of(r["coin"])), []).append(r)

    out = []
    for (criterion, sign, segment), items in sorted(groups.items()):
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
            clusters = _cluster_excess(items, h)
            horizons[f"{h}h"] = {
                "n": len(rets),
                "p_up": round(sum(1 for x in rets if x > 0) / len(rets), 4),
                "mean": round(statistics.fmean(rets), 6),
                "median": round(statistics.median(rets), 6),
                "n_vs_btc": len(excess),
                "mean_vs_btc": round(statistics.fmean(excess), 6) if excess else None,
                "p_beat_btc": round(sum(1 for x in excess if x > 0) / len(excess), 4) if excess else None,
                # Statistiques par grappe (coin, jour) : c'est sur elles que
                # porte le verdict, cf. _cluster_excess.
                "n_clusters": len(clusters),
                "mean_vs_btc_clusters": round(statistics.fmean(clusters), 6) if clusters else None,
                "p_beat_btc_clusters": round(sum(1 for x in clusters if x > 0) / len(clusters), 4) if clusters else None,
            }
        if baseline:
            horizons["24h"].update(_matched_baseline(items, baseline))
        out.append({
            "criterion": criterion,
            "sign": sign,
            "segment": segment,
            # Ce à quoi se comparent les colonnes « vs » : le BTC, ou rien
            # (rendement brut) pour le HIP-3.
            "benchmark": MARKET if segment == "crypto" else None,
            "alerts": len(items),
            "coins": len({r["coin"] for r in items}),
            "horizons": horizons,
        })
    return out


def _matched_baseline(items: list[dict], baseline: list[dict]) -> dict:
    """Témoin apparié : jours ordinaires des MÊMES coins sur la MÊME période,
    hors jours d'alerte du groupe."""
    coins = {r["coin"] for r in items}
    days = [int(r["ts"]) // DAY_MS for r in items]
    lo, hi = min(days), max(days)
    alert_days = {(r["coin"], int(r["ts"]) // DAY_MS) for r in items}
    sample = [
        b["excess_24h"]
        for b in baseline
        if b["coin"] in coins and lo <= b["day"] <= hi and (b["coin"], b["day"]) not in alert_days
    ]
    if not sample:
        return {"baseline_n": 0}
    return {
        "baseline_n": len(sample),
        "baseline_p_beat": round(sum(1 for x in sample if x > 0) / len(sample), 4),
        "baseline_mean": round(statistics.fmean(sample), 6),
    }


def _cluster_excess(items: list[dict], h: int) -> list[float]:
    """Rendement relatif au BTC moyen par grappe (coin, jour UTC).

    Les alertes successives d'un même coin le même jour décrivent le même
    épisode : 85 alertes d'un seul coin ne sont pas 85 observations
    indépendantes. Les traiter comme telles gonflait la significativité (un
    « z = 2,9 » constaté sur un seul coin). Une grappe = une observation.
    """
    by: dict[tuple[str, int], list[float]] = {}
    for r in items:
        a, b = r.get(f"ret_{h}h"), r.get(f"btc_{h}h")
        if a is None or b is None or r["coin"] == MARKET:
            continue
        by.setdefault((r["coin"], int(r["ts"]) // 86400_000), []).append(a - b)
    return [statistics.fmean(v) for v in by.values()]


# --- Orchestration (appelée par le cycle de collecte) ---------------------------
async def maybe_process(client, now_ms: int | None = None) -> dict | None:
    """Calcule les résultats d'un petit lot d'alertes, au plus toutes les 2 min."""
    now_ms = now_ms or int(time.time() * 1000)
    if not db.try_claim(_PASS_KEY, now_ms, PASS_EVERY_SEC * 1000):
        return None

    pending = db.pending_alert_outcomes(now_ms, [h * 3600_000 + COARSE["ms"] for h in HORIZONS_H], LOOKBACK_DAYS)
    if not pending:
        return await _backfill_baseline(client, now_ms)

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
    # Le BTC n'est téléchargé que pour les résolutions où le lot contient des
    # cryptos : un lot 100 % HIP-3 n'a pas de référence.
    crypto_intervals = {iv for (coin, iv) in groups if segment_of(coin) == "crypto"}
    market = {iv: await _candles(client, MARKET, iv, *ranges[iv]) for iv in crypto_intervals}

    results = []
    baseline: list[tuple[str, int, float]] = []
    for (coin, interval), items in groups.items():
        res = res_by_interval[interval]
        lo, hi = ranges[interval]
        bench = market[interval] if segment_of(coin) == "crypto" else None
        candles = market[interval] if coin == MARKET else await _candles(client, coin, interval, lo, hi)
        for p in items:
            results.append({**p, **outcome(candles, bench, p["ts"], res)})
        baseline.extend(baseline_from_candles(coin, candles, bench, res))

    db.upsert_alert_outcomes(results, now_ms)
    db.insert_baseline_days(baseline)
    logger.info("Track record : %d alertes sur %s", len(results), ",".join(coins))
    return {"processed": len(results), "coins": coins, "pending": len(pending)}


async def _backfill_baseline(client, now_ms: int) -> dict:
    """Une fois les alertes à jour : calcule le témoin des coins mesurés avant
    son introduction. Bougies d'1 h (assez pour des fenêtres de 24 h, et
    disponibles sur toute la plage)."""
    todo = [c for c in db.coins_missing_baseline(COINS_PER_PASS) if c["coin"] != MARKET]
    if not todo:
        return {"processed": 0}
    lo = min(c["lo"] for c in todo) - DAY_MS
    hi = min(max(c["hi"] for c in todo) + 2 * DAY_MS, now_ms)
    needs_market = any(segment_of(c["coin"]) == "crypto" for c in todo)
    market = await _candles(client, MARKET, COARSE["interval"], lo, hi) if needs_market else None
    rows: list[tuple[str, int, float]] = []
    for c in todo:
        candles = await _candles(client, c["coin"], COARSE["interval"], c["lo"] - DAY_MS, min(c["hi"] + 2 * DAY_MS, now_ms))
        bench = market if segment_of(c["coin"]) == "crypto" else None
        rows.extend(baseline_from_candles(c["coin"], candles, bench, COARSE))
    db.insert_baseline_days(rows)
    logger.info("Témoin : %d jours pour %s", len(rows), ",".join(c["coin"] for c in todo))
    return {"processed": 0, "baseline_days": len(rows), "coins": [c["coin"] for c in todo]}


async def _candles(client, coin: str, interval: str, lo: int, hi: int) -> list[tuple[int, float]]:
    raw = await client.get_candles(coin, interval, lo, hi)
    return sorted((int(c["t"]), float(c["o"])) for c in raw if c.get("o") is not None)


def summary() -> dict:
    rows = db.alert_outcomes_rows(LOOKBACK_DAYS)
    since_day = (int(time.time() * 1000) - LOOKBACK_DAYS * DAY_MS) // DAY_MS
    baseline = db.baseline_rows(since_day)
    return {
        "groups": aggregate(rows, baseline),
        "outcomes": len(rows),
        "baseline_days": len(baseline),
        "horizons_h": list(HORIZONS_H),
        "lookback_days": LOOKBACK_DAYS,
    }
