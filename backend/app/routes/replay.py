"""Route de replay historique (backtest de la confluence v2).

Protégée par le même bearer que le cron : la requête charge potentiellement
des centaines de milliers de lignes — pas une route à exposer au public.
"""
from __future__ import annotations

import time

from fastapi import APIRouter, Header, HTTPException, Query

from .. import replay
from .cron import _authorized

router = APIRouter(prefix="/api", tags=["replay"])


@router.get("/replay")
async def run_replay(
    hours: int = Query(24, ge=3, le=168, description="Fenêtre d'historique à rejouer"),
    step_min: int = Query(10, ge=1, le=60, description="Pas de la grille d'évaluation"),
    horizons: str = Query("60,240", description="Horizons de rendement en minutes, CSV"),
    authorization: str | None = Header(default=None),
):
    if not _authorized(authorization):
        raise HTTPException(status_code=401, detail="Non autorisé")

    try:
        horizons_min = sorted({int(h) for h in horizons.split(",") if h.strip()})
    except ValueError:
        raise HTTPException(status_code=422, detail="horizons: liste d'entiers en minutes")
    if not horizons_min or horizons_min[-1] > 24 * 60:
        raise HTTPException(status_code=422, detail="horizons: 1 à 1440 minutes")

    until_ms = int(time.time() * 1000)
    since_ms = until_ms - hours * 3600 * 1000
    result = replay.run(since_ms, until_ms, step_min * 60 * 1000, horizons_min)

    if result["grid_points"] == 0:
        raise HTTPException(
            status_code=422,
            detail=(
                "Fenêtre inexploitable : il faut au moins "
                "2h de warm-up (baseline volume) + le plus grand horizon "
                "d'historique contigu. Réduisez les horizons ou attendez que "
                "la collecte accumule davantage."
            ),
        )
    return result
