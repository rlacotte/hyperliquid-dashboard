"""Leaderboard distillé : profils de traders, pour séparer le talent de la chance.

Le leaderboard officiel Hyperliquid (stats-data) pèse ~39 Mo pour ~48 000
comptes : impossible à charger dans un navigateur. On le distille ici en
quelques milliers de lignes compactes, enrichies d'un PROFIL.

Pourquoi des profils : un classement par PnL mélange des choses sans rapport.
Sur les 15 premiers du PnL 30 j au moment de l'analyse, on trouvait côte à côte :
- un compte à +30 M$ avec un volume NUL — son PnL ne vient pas du trading
  (détention spot ou vault qui s'apprécie) ;
- un compte à 438× de rotation mensuelle et 7 points de base de marge par
  dollar échangé — signature d'un teneur de marché, pas d'un pari directionnel ;
- un compte à +24 M$ sur le mois mais −17 M$ sur tout son historique.
Aucun n'est un « bon trader à suivre » au sens où l'entend un visiteur.

Les règles sont volontairement simples et affichées dans l'interface : un
classement opaque reproduirait le défaut qu'on corrige.
"""
from __future__ import annotations

import logging
import time
from datetime import datetime, timezone
from typing import Any

import httpx

from . import db

logger = logging.getLogger(__name__)

LEADERBOARD_URL = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard"
KV_KEY = "leaderboard"
REFRESH_EVERY_SEC = 30 * 60
SNAPSHOT_KEY = "leaderboard_snapshot_day"
CLAIM_KEY = "leaderboard_refresh_claim"
CLAIM_TTL_SEC = 3 * 60

# Seuils de profil (calibrés sur la distribution réelle : rotation mensuelle
# médiane ~0×, p90 ~25×, p99 ~346× parmi les comptes > 100 k$).
MIN_ACCOUNT_VALUE = 100_000
PASSIVE_MAX_TURNOVER = 0.5      # a échangé moins de la moitié de son capital en 30 j
MM_MIN_TURNOVER = 200           # rotation de teneur de marché
MM_MAX_EDGE = 0.0025            # < 25 points de base de PnL par dollar échangé

# Sélection conservée (union) : de quoi trier côté client sans transférer 39 Mo.
KEEP_TOP_PNL_MONTH = 1500
KEEP_TOP_ROI_MONTH = 500
KEEP_TOP_PNL_ALL = 500
KEEP_TOP_VALUE = 500
SNAPSHOT_TOP = 2000

WINDOWS = ("day", "week", "month", "allTime")


def _window(row: dict, name: str) -> tuple[float, float, float]:
    perf = dict(row.get("windowPerformances") or [])
    w = perf.get(name) or {}
    return float(w.get("pnl") or 0), float(w.get("roi") or 0), float(w.get("vlm") or 0)


def classify(account_value: float, pnl_week: float, pnl_month: float, pnl_all: float, vlm_month: float) -> str:
    """Profil d'un compte, par ordre de priorité. Fonction pure, testée.

    - passive        : PnL sans activité de trading proportionnée.
    - market_maker   : énorme rotation, marge infime par dollar échangé.
    - rebound        : gagnant sur 30 j mais perdant sur tout l'historique.
    - consistent     : gagnant sur la semaine, le mois ET tout l'historique.
    - directional    : le reste.
    """
    turnover = vlm_month / account_value if account_value > 0 else 0.0
    if turnover < PASSIVE_MAX_TURNOVER and pnl_month != 0:
        return "passive"
    edge = abs(pnl_month) / vlm_month if vlm_month > 0 else 0.0
    if turnover >= MM_MIN_TURNOVER and edge < MM_MAX_EDGE:
        return "market_maker"
    if pnl_month > 0 and pnl_all < 0:
        return "rebound"
    if pnl_week > 0 and pnl_month > 0 and pnl_all > 0:
        return "consistent"
    return "directional"


def distill(rows: list[dict]) -> list[dict]:
    """Garde l'union des meilleurs selon plusieurs axes, en format compact."""
    candidates = []
    for r in rows:
        try:
            av = float(r.get("accountValue") or 0)
        except (TypeError, ValueError):
            continue
        if av < MIN_ACCOUNT_VALUE:
            continue
        w = {name: _window(r, name) for name in WINDOWS}
        p_day, _, v_day = w["day"]
        p_week, r_week, v_week = w["week"]
        p_month, r_month, v_month = w["month"]
        p_all, r_all, v_all = w["allTime"]
        if v_month == 0 and p_month == 0 and v_all == 0:
            continue  # compte dormant
        candidates.append({
            "a": r["ethAddress"].lower(),
            "n": r.get("displayName") or None,
            "av": round(av, 2),
            "pd": round(p_day, 2),
            "pw": round(p_week, 2),
            "pm": round(p_month, 2),
            "pa": round(p_all, 2),
            "rw": round(r_week, 5),
            "rm": round(r_month, 5),
            "ra": round(r_all, 5),
            "vm": round(v_month, 2),
            "va": round(v_all, 2),
            "pr": classify(av, p_week, p_month, p_all, v_month),
        })

    keep: dict[str, dict] = {}
    for key, n in (("pm", KEEP_TOP_PNL_MONTH), ("rm", KEEP_TOP_ROI_MONTH), ("pa", KEEP_TOP_PNL_ALL), ("av", KEEP_TOP_VALUE)):
        for c in sorted(candidates, key=lambda c: c[key], reverse=True)[:n]:
            keep[c["a"]] = c
    return sorted(keep.values(), key=lambda c: c["pm"], reverse=True)


async def fetch_rows(client: httpx.AsyncClient) -> list[dict]:
    resp = await client.get(LEADERBOARD_URL, timeout=45.0)
    resp.raise_for_status()
    return resp.json().get("leaderboardRows", [])


async def maybe_refresh(client: httpx.AsyncClient, now_ms: int | None = None) -> dict | None:
    """Rafraîchit au plus toutes les REFRESH_EVERY_SEC. Appelé par le cycle de collecte."""
    now_ms = now_ms or int(time.time() * 1000)
    stored = db.kv_get(KV_KEY)
    if stored and now_ms - stored[0] < REFRESH_EVERY_SEC * 1000:
        return None

    # Le pinger appelle la collecte toutes les 30 s et une invocation peut en
    # chevaucher une autre : sans réservation, deux fonctions téléchargeraient
    # les 39 Mo en parallèle. On réserve donc le créneau AVANT le fetch ; une
    # réservation abandonnée (fonction tuée) expire au bout de CLAIM_TTL.
    claim = db.kv_get(CLAIM_KEY)
    if claim and now_ms - claim[0] < CLAIM_TTL_SEC * 1000:
        return None
    db.kv_set(CLAIM_KEY, now_ms, {"at": now_ms})

    started = time.time()
    rows = await fetch_rows(client)
    distilled = distill(rows)
    db.kv_set(KV_KEY, now_ms, {"total": len(rows), "rows": distilled})
    snapshot = _maybe_snapshot(distilled, now_ms)
    logger.info("Leaderboard: %d comptes → %d distillés (%.1fs)", len(rows), len(distilled), time.time() - started)
    return {"total": len(rows), "kept": len(distilled), "snapshot": snapshot}


def _maybe_snapshot(distilled: list[dict], now_ms: int) -> int | None:
    """Une photo par jour du haut du classement.

    Elle servira à tester la PERSISTANCE : un trader du top 30 j le reste-t-il
    les 30 jours suivants ? Personne ne publie cette mesure ; elle demande un
    historique qu'il faut commencer à accumuler.
    """
    day = datetime.fromtimestamp(now_ms / 1000, tz=timezone.utc).date().isoformat()
    stored = db.kv_get(SNAPSHOT_KEY)
    if stored and stored[1].get("day") == day:
        return None
    top = sorted(distilled, key=lambda c: c["pm"], reverse=True)[:SNAPSHOT_TOP]
    n = db.insert_leaderboard_snapshot(day, top)
    db.kv_set(SNAPSHOT_KEY, now_ms, {"day": day})
    return n


def get_cached() -> tuple[int, Any] | None:
    return db.kv_get(KV_KEY)
