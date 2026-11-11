"""Historique des perps du DEX principal, pour le simulateur de scénarios BTC.

Le simulateur (côté navigateur) estime comment chaque token s'est comporté
face au BTC, puis projette ce comportement sur une performance supposée du
BTC. Il lui faut les rendements hebdomadaires de tous les perps depuis leur
cotation : ~235 requêtes de bougies, trop pour un navigateur (limite de débit
Hyperliquid par IP). Le serveur les relève donc une fois par jour, par petits
lots dans le cycle de collecte, et publie une matrice compacte.

Deux particularités des données Hyperliquid, constatées :
- les bougies des grandes capitalisations remontent à 2020, bien avant
  l'ouverture de la plateforme (historique reconstitué, volume nul) : les
  cours sont justes, mais la liquidité de l'époque est inconnue ;
- les coins retirés de la cote gardent leurs bougies. On les conserve
  (drapeau `x`) : la validation hors échantillon du modèle serait biaisée si
  elle ne voyait que les survivants.
"""
from __future__ import annotations

import asyncio
import logging
import math

from . import db

logger = logging.getLogger(__name__)

DAY_MS = 86_400_000
# Coins relevés par cycle : une requête candleSnapshot chacun (poids 20 + 1 par
# 60 bougies). 5 par minute = tout l'univers en ~45 min après minuit UTC.
BATCH = 5
# Marge après minuit UTC avant de considérer la bougie de la veille comme close.
SETTLE_MS = 5 * 60_000
MAX_WEEKS = 340
# Fenêtre de la liquidité publiée : volume quotidien moyen sur 30 jours.
LIQUIDITY_DAYS = 30
LIQ_UNKNOWN = -1
_MATRIX_KEY = "scenario_matrix"
# Jour déjà publié, dans une clé à part : la matrice pèse ~270 Ko, la relire à
# chaque cycle juste pour connaître sa date coûterait du CPU pour rien.
_DAY_KEY = "scenario_matrix_day"
BTC = "BTC"

# Mémo par instance : une fois la matrice du jour publiée, plus aucune requête
# jusqu'au lendemain.
_published_day: int | None = None


def merge_history(existing: dict | None, candles: list[dict], target_day: int, delisted: bool) -> tuple[int, list[float], list[float]] | None:
    """Fusionne des bougies journalières dans l'historique d'un coin.

    Rend (premier jour, cours, volumes en dollars) du premier jour coté jusqu'à
    `target_day` — ou jusqu'à la dernière bougie pour un coin retiré, dont
    l'histoire s'arrête là. Les jours sans bougie (aucun échange) reprennent le
    dernier cours, volume nul. La bougie du jour en cours (au-delà de
    `target_day`) est ignorée : elle n'est pas close. None si aucun cours.
    """
    by_day: dict[int, tuple[float, float]] = {}
    if existing and existing.get("closes"):
        volumes = existing.get("volumes") or []
        for i, c in enumerate(existing["closes"]):
            by_day[existing["first_day"] + i] = (c, volumes[i] if i < len(volumes) else 0.0)
    for k in candles:
        try:
            day, close = int(k["t"]) // DAY_MS, float(k["c"])
            volume = float(k.get("v") or 0) * close
        except (KeyError, TypeError, ValueError):
            continue
        if day <= target_day and close > 0 and math.isfinite(close):
            by_day[day] = (close, volume if math.isfinite(volume) else 0.0)
    if not by_day:
        return None
    first = min(by_day)
    last = max(by_day) if delisted else target_day
    closes: list[float] = []
    volumes_out: list[float] = []
    prev = by_day[first][0]
    for d in range(first, last + 1):
        if d in by_day:
            prev, vol = by_day[d]
        else:
            vol = 0.0
        closes.append(prev)
        volumes_out.append(round(vol))
    return first, closes, volumes_out


def liquidity_code(volumes: list[float], first_volume_idx: int | None, end_idx: int) -> int:
    """Liquidité à la fin d'une semaine : 10 × log10 du volume quotidien moyen
    sur 30 jours (60 = 1 M$, 70 = 10 M$). LIQ_UNKNOWN tant que le coin n'a pas
    une semaine de volume réel (historique reconstitué)."""
    if first_volume_idx is None or end_idx < first_volume_idx + 6:
        return LIQ_UNKNOWN
    lo = max(first_volume_idx, end_idx - LIQUIDITY_DAYS + 1)
    window = volumes[lo : end_idx + 1]
    avg = sum(window) / len(window)
    return max(0, round(10 * math.log10(max(avg, 1.0))))


def weekly_series(first_day: int, closes: list[float], volumes: list[float], anchor_day: int, max_weeks: int) -> tuple[list[int], list[int], int]:
    """Rendements log hebdomadaires en points de base (× 10 000) et code de
    liquidité, du plus ancien au plus récent, sur des semaines de 7 jours
    finissant à `anchor_day`.

    Rend (rendements, liquidités, e) où `e` est le nombre de semaines manquantes
    à la fin (coin retiré de la cote avant l'ancre ; 0 pour un coin vivant).
    Seules les semaines entièrement couvertes par l'historique sont rendues.
    """
    last_day = first_day + len(closes) - 1
    first_volume_idx = next((i for i, v in enumerate(volumes) if v > 0), None)
    rets: list[int] = []
    liq: list[int] = []
    skipped_end = 0
    for k in range(max_weeks):
        end, start = anchor_day - 7 * k, anchor_day - 7 * (k + 1)
        if end > last_day:
            # Semaine postérieure au retrait de la cote.
            skipped_end += 1
            continue
        if start < first_day:
            break
        rets.append(round(math.log(closes[end - first_day] / closes[start - first_day]) * 10_000))
        liq.append(liquidity_code(volumes, first_volume_idx, end - first_day))
    rets.reverse()
    liq.reverse()
    return rets, liq, skipped_end if rets else 0


def build_matrix(rows: list[dict], anchor_day: int, max_weeks: int = MAX_WEEKS) -> dict:
    coins = []
    for r in rows:
        closes = r["closes"] or []
        if len(closes) < 8:
            continue
        volumes = list(r.get("volumes") or [])
        volumes += [0.0] * (len(closes) - len(volumes))
        rets, liq, e = weekly_series(r["first_day"], closes, volumes, anchor_day, max_weeks)
        if not rets:
            continue
        item: dict = {"c": r["coin"], "r": rets, "v": liq}
        if r["delisted"]:
            item["x"] = True
        if e:
            item["e"] = e
        coins.append(item)
    # BTC en tête : c'est l'axe de tout le reste.
    coins.sort(key=lambda c: (c["c"] != BTC, c["c"]))
    return {"anchor_day": anchor_day, "weeks": max((len(c["r"]) + c.get("e", 0) for c in coins), default=0), "coins": coins}


async def process(client, universe: list[dict], now_ms: int, batch: int = BATCH) -> dict | None:
    """Relève un lot de coins en retard d'un jour ; publie la matrice une fois
    la passe finie. Rend None s'il n'y a rien à faire."""
    global _published_day
    target = now_ms // DAY_MS - 1
    if now_ms % DAY_MS < SETTLE_MS or _published_day == target:
        return None
    marker = db.kv_get(_DAY_KEY)
    if marker and marker[1].get("day") == target:
        _published_day = target
        return None
    # {coin: retiré de la cote ?} — DEX principal seulement.
    delisted = {u["name"]: bool(u.get("isDelisted")) for u in universe if u.get("name") and ":" not in u["name"]}
    status = db.price_history_status()

    def stale(coin: str) -> bool:
        s = status.get(coin)
        if s is None:
            return True
        # Un coin retiré dont l'histoire est déjà relevée ne bouge plus.
        if delisted[coin] and s["delisted"]:
            return False
        return max(s["updated_day"], s["tried_day"]) < target

    todo = [c for c in delisted if stale(c)]
    if not todo:
        matrix = build_matrix(db.price_history_all(), target)
        db.kv_set(_MATRIX_KEY, now_ms, matrix)
        db.kv_set(_DAY_KEY, now_ms, {"day": target})
        _published_day = target
        logger.info("Scénarios : matrice publiée (%d coins, %d semaines)", len(matrix["coins"]), matrix["weeks"])
        return {"matrix": len(matrix["coins"]), "weeks": matrix["weeks"]}

    # Le BTC d'abord, puis les moins récemment relevés.
    todo.sort(key=lambda c: (c != BTC, status[c]["updated_day"] if c in status else -1, c))
    chosen = todo[:batch]
    existing = db.price_history_get(chosen)

    async def fetch(coin: str):
        prev = existing.get(coin)
        # Reprise deux jours avant le dernier jour connu : recouvre une bougie corrigée.
        start = (prev["updated_day"] - 2) * DAY_MS if prev and prev["closes"] else 0
        return await client.get_candles(coin, "1d", max(0, start))

    results = await asyncio.gather(*(fetch(c) for c in chosen), return_exceptions=True)
    rows, failed = [], []
    for coin, res in zip(chosen, results):
        prev = existing.get(coin)
        error = isinstance(res, BaseException)
        merged = None if error else merge_history(prev, res, target, delisted[coin])
        if error:
            failed.append(coin)
        if merged is None:
            # Échec ou coin sans aucun cours : marqué « essayé » pour ne pas
            # bloquer la passe ; un échec sera repris demain.
            rows.append(
                {
                    "coin": coin,
                    "first_day": prev["first_day"] if prev else target + 1,
                    "updated_day": prev["updated_day"] if prev else 0,
                    "tried_day": target,
                    "delisted": False if error else delisted[coin],
                    "closes": prev["closes"] if prev else [],
                    "volumes": (prev.get("volumes") or []) if prev else [],
                }
            )
            continue
        first, closes, volumes = merged
        rows.append(
            {
                "coin": coin,
                "first_day": first,
                "updated_day": first + len(closes) - 1,
                "tried_day": target,
                "delisted": delisted[coin],
                "closes": closes,
                "volumes": volumes,
            }
        )
    db.price_history_upsert(rows)
    return {"updated": len(rows) - len(failed), "failed": failed, "remaining": len(todo) - len(chosen)}


def current() -> dict | None:
    stored = db.kv_get(_MATRIX_KEY)
    return {"ts": stored[0], **stored[1]} if stored else None
