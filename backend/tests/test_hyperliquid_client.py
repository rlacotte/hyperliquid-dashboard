"""Client Hyperliquid : relance unique sur erreur de transport."""
from __future__ import annotations

import asyncio

import httpx
import pytest

from app import hyperliquid_client as hc


def client_with(handler) -> hc.HyperliquidClient:
    c = hc.HyperliquidClient()
    c._client = httpx.AsyncClient(base_url="https://api.test", transport=httpx.MockTransport(handler))
    return c


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    async def instant(_s):
        return None

    monkeypatch.setattr(hc.asyncio, "sleep", instant)


def test_socket_morte_absorbee_par_une_relance():
    """Le cas constaté en production : connexion keep-alive fermée par le serveur
    pendant le gel de l'instance serverless."""
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        if calls["n"] == 1:
            raise httpx.RemoteProtocolError("Server disconnected without sending a response.")
        return httpx.Response(200, json={"mids": {"BTC": "1"}})

    assert asyncio.run(client_with(handler).get_all_mids()) == {"BTC": "1"}
    assert calls["n"] == 2


def test_une_vraie_panne_remonte_apres_une_seule_relance():
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        raise httpx.ConnectTimeout("timeout")

    with pytest.raises(httpx.ConnectTimeout):
        asyncio.run(client_with(handler).get_all_mids())
    assert calls["n"] == 2


def test_une_erreur_http_n_est_pas_relancee():
    """Un 429 ou un 500 est une réponse du serveur : la rejouer immédiatement
    aggraverait une limite de débit."""
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        return httpx.Response(429)

    with pytest.raises(httpx.HTTPStatusError):
        asyncio.run(client_with(handler).get_all_mids())
    assert calls["n"] == 1


def test_expiration_courte_des_connexions_inactives():
    """Garde-fou de configuration : la réutilisation d'une connexion d'un cycle
    précédent (60 s) doit être impossible."""
    assert hc._KEEPALIVE_EXPIRY_SEC < 60
