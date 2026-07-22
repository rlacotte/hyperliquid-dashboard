"""Client async pour l'API publique Hyperliquid (endpoint /info).

Aucune authentification requise : toutes ces requêtes sont en lecture seule et
publiques. On appelle directement POST /info avec un body JSON {"type": ...}.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

import httpx

from . import config

logger = logging.getLogger(__name__)


class HyperliquidClient:
    def __init__(self) -> None:
        self._client = httpx.AsyncClient(
            base_url=config.HYPERLIQUID_API_URL,
            timeout=config.HTTP_TIMEOUT_SEC,
            headers={"Content-Type": "application/json"},
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _post_info(self, body: dict[str, Any]) -> Any:
        resp = await self._client.post("/info", json=body)
        resp.raise_for_status()
        return resp.json()

    # --- Données agrégées ----------------------------------------------------
    async def get_meta_and_asset_ctxs(self) -> tuple[list[dict], list[dict]]:
        """Retourne (universe[], assetCtxs[]) pour tous les perps en un appel.

        universe[i] contient name, szDecimals, maxLeverage...
        assetCtxs[i] contient funding, openInterest, dayNtlVlm, markPx, prevDayPx...
        Alignement positionnel : universe[i] <-> assetCtxs[i].
        """
        data = await self._post_info({"type": "metaAndAssetCtxs"})
        # La réponse est [meta, assetCtxs] où meta = {universe, ...}
        meta = data[0]
        asset_ctxs = data[1]
        return meta.get("universe", []), asset_ctxs

    async def get_all_mids(self) -> dict[str, str]:
        """Mid prices pour tous les actifs. Clés perp = 'BTC', spot = '@PURPLE'."""
        data = await self._post_info({"type": "allMids"})
        return data.get("mids", {})

    # --- Données par actif ---------------------------------------------------
    async def get_candles(
        self, coin: str, interval: str, start_ms: int, end_ms: int | None = None
    ) -> list[dict]:
        """OHLCV via candleSnapshot. interval: 1m,5m,15m,1h,2h,4h,1d..."""
        req: dict[str, Any] = {"coin": coin, "interval": interval, "startTime": start_ms}
        if end_ms is not None:
            req["endTime"] = end_ms
        data = await self._post_info({"type": "candleSnapshot", "req": req})
        return data if isinstance(data, list) else []

    async def get_funding_history(
        self, coin: str, start_ms: int, end_ms: int | None = None
    ) -> list[dict]:
        body: dict[str, Any] = {"type": "fundingHistory", "coin": coin, "startTime": start_ms}
        if end_ms is not None:
            body["endTime"] = end_ms
        data = await self._post_info(body)
        # fundingHistory retourne une liste directe d'événements (pas un dict)
        if isinstance(data, list):
            return data
        return data.get("events", []) if isinstance(data, dict) else []

    async def get_l2_book(self, coin: str) -> dict:
        return await self._post_info({"type": "l2Book", "coin": coin})


# Singleton partagé
_client: HyperliquidClient | None = None


def get_client() -> HyperliquidClient:
    global _client
    if _client is None:
        _client = HyperliquidClient()
    return _client
