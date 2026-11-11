"""Matrice de rendements hebdomadaires pour le simulateur de scénarios BTC
(cf. app/scenarios.py). Le calcul des scénarios se fait dans le navigateur."""
from __future__ import annotations

import time

from fastapi import APIRouter, Header, HTTPException

from .. import scenarios
from ..hyperliquid_client import fresh_client
from .cron import _authorized

router = APIRouter(prefix="/api", tags=["scenarios"])


@router.get("/scenarios")
async def get_scenarios():
    data = scenarios.current()
    if data is None:
        raise HTTPException(status_code=503, detail="Historique en cours de constitution : disponible dans l'heure")
    return data


@router.post("/scenarios/refresh")
async def refresh_scenarios(batch: int = 20, authorization: str | None = Header(default=None)):
    """Avance le relevé d'un gros lot — pour constituer l'historique initial
    sans attendre les ~45 cycles du rythme normal (protégé par CRON_SECRET)."""
    if not _authorized(authorization):
        raise HTTPException(status_code=401, detail="Non autorisé")
    async with fresh_client() as hl:
        universe, _ = await hl.get_meta_and_asset_ctxs()
        return await scenarios.process(hl, universe, int(time.time() * 1000), batch=max(1, min(batch, 25))) or {"done": True}
