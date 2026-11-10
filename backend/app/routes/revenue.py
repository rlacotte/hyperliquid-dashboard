"""Revenus des protocoles cotés sur Hyperliquid (cf. app/revenue.py)."""
from __future__ import annotations

import time

from fastapi import APIRouter, Header, HTTPException

from .. import revenue
from ..hyperliquid_client import fresh_client
from .cron import _authorized

router = APIRouter(prefix="/api", tags=["revenue"])


@router.get("/revenue")
async def get_revenue():
    data = revenue.current()
    if data is None:
        raise HTTPException(status_code=503, detail="Revenus pas encore collectés : disponibles au prochain cycle")
    return data


@router.post("/revenue/refresh")
async def refresh_revenue(authorization: str | None = Header(default=None)):
    """Relevé immédiat, sans attendre le cycle des 3 h — utile après un
    changement du format des données (protégé par CRON_SECRET)."""
    if not _authorized(authorization):
        raise HTTPException(status_code=401, detail="Non autorisé")
    async with fresh_client() as hl:
        universe, _ = await hl.get_meta_and_asset_ctxs()
        perps = [u["name"] for u in universe if u.get("name") and not u.get("isDelisted")]
        return await revenue.refresh(hl._client, hl, perps, int(time.time() * 1000))
