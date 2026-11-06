"""Route : track record public des alertes."""
from __future__ import annotations

from fastapi import APIRouter

from .. import track_record

router = APIRouter(prefix="/api", tags=["signals"])


@router.get("/track-record")
async def get_track_record():
    """Ce qui a suivi chaque type d'alerte, par sens et par horizon.

    Mis en cache 5 min au CDN : les résultats ne changent qu'au rythme des
    horizons qui arrivent à maturité.
    """
    return track_record.summary()
