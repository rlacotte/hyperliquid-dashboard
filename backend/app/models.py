"""Modèles Pydantic partagés entre l'API et le moteur d'alertes."""
from __future__ import annotations

from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


class Severity(str, Enum):
    INFO = "info"
    WARNING = "warning"
    CRITICAL = "critical"


class Criterion(str, Enum):
    FUNDING_RATE = "funding_rate"
    OPEN_INTEREST = "open_interest"
    VOLUME = "volume"
    PRICE_CHANGE = "price_change"
    CONFLUENCE = "confluence"
    FUNDING_ARB = "funding_arb"


class AssetMarket(BaseModel):
    """État marché d'un actif perp, aligné avec metaAndAssetCtxs."""

    coin: str
    sz_decimals: int = 0
    max_leverage: int = 0
    mark_px: float = 0.0
    oracle_px: float = 0.0
    mid_px: float = 0.0
    funding: float = 0.0
    open_interest: float = 0.0
    open_interest_usd: float = 0.0
    prev_day_px: float = 0.0
    day_ntl_vlm: float = 0.0
    day_base_vlm: float = 0.0
    change_24h_pct: float = 0.0


class MarketsResponse(BaseModel):
    ts: int
    assets: list[AssetMarket]


class AlertOut(BaseModel):
    id: int
    coin: str
    ts: int
    criterion: Criterion
    severity: Severity
    message: str
    details: dict
    acknowledged: int = 0  # 0/1
    resolved_ts: Optional[int] = None
    active: int = 1  # 1=active, 0=résolue/acquittée
    score: Optional[float] = None      # score de confluence (pour les alertes CONFLUENCE)
    direction: Optional[str] = None    # "bullish" | "bearish" | "neutral"


class Candle(BaseModel):
    t: int  # open time (ms)
    o: float
    h: float
    l: float
    c: float
    v: float  # volume base


class FundingPoint(BaseModel):
    time: int  # ms
    funding: float
