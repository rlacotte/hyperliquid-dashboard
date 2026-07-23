"""Replay historique : évalue la confluence v2 sur les snapshots passés.

Objectif : savoir si les régimes (strong_bull, strong_bear...) prédisent quoi
que ce soit, en mesurant le rendement *à venir* du prix après chaque signal.

Méthode :
- une grille d'instants T sur la fenêtre demandée ;
- à chaque T, reconstruction d'un HistoryContext depuis les snapshots — mêmes
  fenêtres, mêmes tolérances que la collecte live — puis appel du
  compute_confluence DE PRODUCTION. Aucun seuil réimplémenté ici : si le calcul
  live change, le replay change avec lui, sinon le backtest ne prouve rien ;
- pour chaque signal (régime != none), rendement du prix à T+horizon ;
- agrégation par régime : effectif, taux de réussite directionnel, moyenne,
  médiane. Les coins sans régime au même instant forment le groupe témoin
  « none » — un hit rate ne se lit que contre cette base.

Tout est chargé en une requête puis rejoué en mémoire : ~2000 instants x 230
coins interrogés point par point feraient des centaines de milliers
d'allers-retours SQL.

Limites assumées (à garder en tête en lisant les chiffres) :
- le rendement mesuré est mark-to-mark, sans frais ni funding ni slippage ;
- les signaux d'un même coin à des T successifs sont autocorrélés (une tendance
  de 2h produit ~12 signaux sur une grille de 10 min, pas 12 preuves
  indépendantes) ;
- au-delà de 3h d'âge, les snapshots sont downsamplés à 5 min : les fenêtres
  courtes (volume 10 min) y sont plus bruitées qu'en live.
"""
from __future__ import annotations

import logging
import time
from bisect import bisect_left
from statistics import median

from psycopg.rows import tuple_row

from . import config, db
from .confluence import compute_confluence
from .db import HistoryContext
from .models import AssetMarket

logger = logging.getLogger(__name__)

# Mêmes tolérances que la collecte live (cf. db.load_history_context)
_TOLERANCE_MS = 10 * 60 * 1000

# Champs des points de série : (ts, mark_px, funding, open_interest, day_ntl_vlm)
_TS, _PX, _FUNDING, _OI, _VLM = range(5)


def load_series(since_ms: int, until_ms: int) -> dict[str, list[tuple]]:
    """Toutes les séries par coin en une requête, triées par ts.

    Lignes en tuples (pas en dicts) : la fenêtre peut dépasser 500k lignes et
    le surcoût mémoire des dicts serait le facteur limitant de la fonction.
    """
    series: dict[str, list[tuple]] = {}
    with db.get_conn() as conn:
        with conn.cursor(row_factory=tuple_row) as cur:
            cur.execute(
                "SELECT coin, ts, mark_px, funding, open_interest, day_ntl_vlm "
                "FROM snapshots WHERE ts BETWEEN %s AND %s ORDER BY coin, ts",
                (since_ms, until_ms),
            )
            for coin, *point in cur:
                series.setdefault(coin, []).append(tuple(point))
    return series


def value_at(points: list[tuple], target_ms: int, tol_ms: int = _TOLERANCE_MS) -> tuple | None:
    """Le point le plus proche de target_ms dans la tolérance (bisect, O(log n))."""
    if not points:
        return None
    i = bisect_left(points, target_ms, key=lambda p: p[_TS])
    best = None
    for j in (i - 1, i):
        if 0 <= j < len(points):
            d = abs(points[j][_TS] - target_ms)
            if d <= tol_ms and (best is None or d < abs(best[_TS] - target_ms)):
                best = points[j]
    return best


def _volume_rate(points: list[tuple], since_ms: int, t_ms: int) -> float | None:
    """Pente du volume cumulé 24h sur [since_ms, t_ms] — même méthode que
    db._volume_rates (premier et dernier point de la fenêtre)."""
    lo = bisect_left(points, since_ms, key=lambda p: p[_TS])
    hi = bisect_left(points, t_ms + 1, key=lambda p: p[_TS])
    window = points[lo:hi]
    if len(window) < 2:
        return None
    first, last = window[0], window[-1]
    dt_sec = (last[_TS] - first[_TS]) / 1000.0
    if dt_sec <= 0:
        return None
    return (last[_VLM] - first[_VLM]) / dt_sec


def build_ctx_at(series: dict[str, list[tuple]], t_ms: int) -> HistoryContext:
    """HistoryContext reconstruit à l'instant T, aligné sur la version live."""
    oi_target = t_ms - config.OI_LOOKBACK_MIN * 60 * 1000
    price_target = t_ms - config.PRICE_LOOKBACK_MIN * 60 * 1000
    recent_since = t_ms - config.VOLUME_RECENT_MIN * 60 * 1000
    baseline_since = t_ms - config.VOLUME_BASELINE_MIN * 60 * 1000

    oi_prev: dict[str, dict] = {}
    price_prev: dict[str, dict] = {}
    vol_recent: dict[str, float | None] = {}
    vol_baseline: dict[str, float | None] = {}

    for coin, points in series.items():
        p = value_at(points, oi_target)
        if p is not None:
            oi_prev[coin] = {"ts": p[_TS], "mark_px": p[_PX], "open_interest": p[_OI]}
        if price_target == oi_target:
            if p is not None:
                price_prev[coin] = oi_prev[coin]
        else:
            q = value_at(points, price_target)
            if q is not None:
                price_prev[coin] = {"ts": q[_TS], "mark_px": q[_PX], "open_interest": q[_OI]}
        vol_recent[coin] = _volume_rate(points, recent_since, t_ms)
        vol_baseline[coin] = _volume_rate(points, baseline_since, t_ms)

    return HistoryContext(
        now_ms=t_ms,
        oi_prev=oi_prev,
        price_prev=price_prev,
        vol_recent=vol_recent,
        vol_baseline=vol_baseline,
    )


def _asset_at(coin: str, points: list[tuple], t_ms: int) -> AssetMarket | None:
    p = value_at(points, t_ms)
    if p is None or p[_PX] <= 0:
        return None
    return AssetMarket(
        coin=coin,
        mark_px=p[_PX],
        funding=p[_FUNDING],
        open_interest=p[_OI],
        open_interest_usd=p[_OI] * p[_PX],
        day_ntl_vlm=p[_VLM],
    )


class _Bucket:
    """Agrégat en flux d'une paire (régime, horizon)."""

    __slots__ = ("returns", "hits", "directional")

    def __init__(self) -> None:
        self.returns: list[float] = []
        self.hits = 0
        self.directional = 0

    def add(self, fwd_pct: float, direction: str) -> None:
        self.returns.append(fwd_pct)
        if direction == "bullish":
            self.directional += 1
            self.hits += fwd_pct > 0
        elif direction == "bearish":
            self.directional += 1
            self.hits += fwd_pct < 0
        # neutral (exhaustion, none) : pas de pari directionnel à compter

    def summary(self) -> dict:
        n = len(self.returns)
        return {
            "n": n,
            "avg_pct": round(sum(self.returns) / n * 100, 3) if n else None,
            "median_pct": round(median(self.returns) * 100, 3) if n else None,
            "hit_rate": round(self.hits / self.directional, 3) if self.directional else None,
        }


def run(
    since_ms: int,
    until_ms: int,
    step_ms: int,
    horizons_min: list[int],
) -> dict:
    started = time.time()
    max_horizon_ms = max(horizons_min) * 60 * 1000
    warmup_ms = config.VOLUME_BASELINE_MIN * 60 * 1000

    series = load_series(since_ms, until_ms)
    rows_loaded = sum(len(v) for v in series.values())

    # La grille commence après le warm-up (il faut une baseline de volume
    # complète) et s'arrête assez tôt pour que chaque horizon soit mesurable.
    grid_start = since_ms + warmup_ms
    grid_end = until_ms - max_horizon_ms

    buckets: dict[tuple[str, int], _Bucket] = {}
    examples: list[dict] = []
    grid_points = 0
    signals = 0

    t = grid_start
    while t <= grid_end:
        grid_points += 1
        ctx = build_ctx_at(series, t)
        for coin, points in series.items():
            asset = _asset_at(coin, points, t)
            if asset is None:
                continue
            result = compute_confluence(asset, ctx)
            fwd: dict[int, float] = {}
            for h in horizons_min:
                p_fwd = value_at(points, t + h * 60 * 1000)
                if p_fwd is not None and p_fwd[_PX] > 0:
                    fwd[h] = (p_fwd[_PX] - asset.mark_px) / asset.mark_px
            if not fwd:
                continue
            for h, r in fwd.items():
                buckets.setdefault((result.regime, h), _Bucket()).add(r, result.direction)
            if result.regime != "none":
                signals += 1
                if len(examples) < 50:
                    examples.append({
                        "t": t,
                        "coin": coin,
                        "regime": result.regime,
                        "direction": result.direction,
                        "score": result.score,
                        "fwd_pct": {str(h): round(r * 100, 3) for h, r in fwd.items()},
                    })
        t += step_ms

    regimes: dict[str, dict] = {}
    for (regime, h), bucket in sorted(buckets.items()):
        regimes.setdefault(regime, {"horizons": {}})["horizons"][f"{h}min"] = bucket.summary()

    return {
        "window": {"since_ms": since_ms, "until_ms": until_ms, "step_min": step_ms // 60000},
        "rows_loaded": rows_loaded,
        "coins": len(series),
        "grid_points": grid_points,
        "signals": signals,
        "regimes": regimes,
        "examples": examples,
        "duration_ms": int((time.time() - started) * 1000),
        "caveats": [
            "rendements mark-to-mark, sans frais/funding/slippage",
            "signaux consécutifs d'un même coin autocorrélés (pas indépendants)",
            "zone downsamplée (>3h d'âge) : fenêtres courtes de volume bruitées",
        ],
    }
