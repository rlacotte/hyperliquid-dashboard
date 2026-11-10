"""Revenus des protocoles cotés sur Hyperliquid (cf. app/revenue.py)."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from .. import revenue

router = APIRouter(prefix="/api", tags=["revenue"])


@router.get("/revenue")
async def get_revenue():
    data = revenue.current()
    if data is None:
        raise HTTPException(status_code=503, detail="Revenus pas encore collectés : disponibles au prochain cycle")
    return data
