"""Client async pour l'API publique Hyperliquid (endpoint /info).

Aucune authentification requise : toutes ces requêtes sont en lecture seule et
publiques. On appelle directement POST /info avec un body JSON {"type": ...}.
"""
from __future__ import annotations

import asyncio
import logging
import ssl
from typing import Any

import certifi
import httpx

from . import config

logger = logging.getLogger(__name__)


# Erreurs de transport qui justifient UNE relance : la requête n'a pas abouti
# côté serveur, la rejouer est sans risque (lecture seule).
_RETRYABLE = (httpx.RemoteProtocolError, httpx.ConnectError, httpx.ConnectTimeout, httpx.ReadTimeout)

# Durée de vie d'une connexion inactive dans le pool.
#
# En serverless, l'instance est gelée entre deux cycles (60 s). Le serveur
# distant ferme entre-temps la connexion keep-alive ; au réveil, httpx
# réutilisait une socket morte → « Server disconnected without sending a
# response », constaté en production à chaque cycle ou presque. Une expiration
# de quelques secondes garde la réutilisation AU SEIN d'un cycle (requêtes
# enchaînées) sans jamais réveiller une connexion d'un cycle précédent.
_KEEPALIVE_EXPIRY_SEC = 5.0

# Connexion courte, lecture plus longue : une connexion qui ne s'établit pas en
# 5 s ne s'établira pas en 15 ; autant retenter tout de suite. Constaté en
# production : des ConnectTimeout à 15 s qui consommaient un quart du cycle.
_TIMEOUT = httpx.Timeout(config.HTTP_TIMEOUT_SEC, connect=5.0)
_ATTEMPTS = 3
_BACKOFF_SEC = (0.5, 1.5)


class HyperliquidClient:
    def __init__(self, client: httpx.AsyncClient | None = None) -> None:
        self._client = client or _new_http_client()

    async def aclose(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> "HyperliquidClient":
        return self

    async def __aexit__(self, *exc) -> None:
        await self.aclose()

    async def _post_info(self, body: dict[str, Any]) -> Any:
        for attempt in range(_ATTEMPTS):
            try:
                resp = await self._client.post("/info", json=body)
                break
            except _RETRYABLE as exc:
                # La requête n'a pas abouti côté serveur (lecture seule) : la
                # rejouer est sans risque. Après la dernière tentative, l'erreur
                # remonte — une vraie panne doit rester visible.
                if attempt == _ATTEMPTS - 1:
                    raise
                logger.warning("Hyperliquid %s (%s) : tentative %d/%d", body.get("type"), type(exc).__name__, attempt + 2, _ATTEMPTS)
                await asyncio.sleep(_BACKOFF_SEC[min(attempt, len(_BACKOFF_SEC) - 1)])
        resp.raise_for_status()
        return resp.json()

    # --- Données agrégées ----------------------------------------------------
    async def get_meta_and_asset_ctxs(self, dex: str = "") -> tuple[list[dict], list[dict]]:
        """Retourne (universe[], assetCtxs[]) pour tous les perps d'un DEX en un appel.

        `dex` vide = DEX principal ; sinon un DEX HIP-3 (ex. "xyz"), dont les
        noms de marchés sont préfixés ("xyz:TSLA").
        universe[i] contient name, szDecimals, maxLeverage...
        assetCtxs[i] contient funding, openInterest, dayNtlVlm, markPx, prevDayPx...
        Alignement positionnel : universe[i] <-> assetCtxs[i].
        """
        body: dict[str, Any] = {"type": "metaAndAssetCtxs"}
        if dex:
            body["dex"] = dex
        data = await self._post_info(body)
        # La réponse est [meta, assetCtxs] où meta = {universe, ...}
        meta = data[0]
        asset_ctxs = data[1]
        return meta.get("universe", []), asset_ctxs

    async def get_predicted_fundings(self) -> list:
        """Funding prédit sur Hyperliquid, Binance et Bybit, pour chaque coin."""
        return await self._post_info({"type": "predictedFundings"})

    async def get_perp_dexs(self) -> list[str]:
        """Noms des DEX HIP-3 (le premier élément, null, est le DEX principal)."""
        data = await self._post_info({"type": "perpDexs"})
        return [d["name"] for d in data if isinstance(d, dict) and d.get("name")]

    async def get_all_mids(self) -> dict[str, str]:
        """Mid prices pour tous les actifs. Clés perp = 'BTC', spot = '@PURPLE'."""
        data = await self._post_info({"type": "allMids"})
        return data.get("mids", {})

    # --- Données par compte ---------------------------------------------------
    async def get_user_fills_since(self, user: str, start_ms: int) -> list[dict]:
        """Fills d'un compte depuis `start_ms` (inclus), ordre chronologique,
        tous DEX confondus. Plafonné à 2000 par réponse : au-delà, le lot
        suivant repart du dernier fill reçu."""
        data = await self._post_info({"type": "userFillsByTime", "user": user, "startTime": start_ms})
        return data if isinstance(data, list) else []

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


# Contexte TLS partagé : un client neuf par cycle rechargeait à chaque fois le
# magasin de certificats (load_verify_locations + recherches d'import de
# certifi) — visible au profilage. Le contexte est immuable une fois créé et se
# partage sans risque ; seules les connexions restent propres à chaque cycle.
_SSL_CONTEXT: ssl.SSLContext | None = None


def _ssl_context() -> ssl.SSLContext:
    global _SSL_CONTEXT
    if _SSL_CONTEXT is None:
        _SSL_CONTEXT = ssl.create_default_context(cafile=certifi.where())
    return _SSL_CONTEXT


def _new_http_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        base_url=config.HYPERLIQUID_API_URL,
        timeout=_TIMEOUT,
        verify=_ssl_context(),
        headers={"Content-Type": "application/json"},
        limits=httpx.Limits(keepalive_expiry=_KEEPALIVE_EXPIRY_SEC),
    )


def fresh_client() -> HyperliquidClient:
    """Client neuf, à utiliser en `async with` le temps d'un cycle de collecte.

    En serverless, un AsyncClient de module survit d'une invocation à l'autre :
    son pool de connexions et ses verrous peuvent rester liés à une boucle
    asyncio ou à des sockets d'une invocation précédente. Constaté en
    production : ReadTimeout et ConnectTimeout aléatoires malgré les relances.
    Un client par cycle (une poignée de main TLS par minute) supprime la
    question au lieu de dépendre de l'interne de l'hébergeur.
    """
    return HyperliquidClient()


# Singleton pour les routes HTTP occasionnelles (bougies, funding) ; la collecte
# utilise fresh_client().
_client: HyperliquidClient | None = None


def get_client() -> HyperliquidClient:
    global _client
    if _client is None:
        _client = HyperliquidClient()
    return _client
