"""En-têtes de cache CDN : présents sur les lectures, absents où ils nuiraient."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import db


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(db, "init_db", lambda: None)
    monkeypatch.setattr(db, "get_global_metrics_history", lambda metric, since_ms: [])
    monkeypatch.setattr(db, "get_alerts", lambda **kw: [])

    from app.main import app

    with TestClient(app) as c:
        yield c


def test_les_lectures_sont_cacheables(client):
    resp = client.get("/api/global-metrics/history?metric=fear_greed")
    assert resp.status_code == 200
    assert "s-maxage=60" in resp.headers.get("cache-control", "")


def test_les_alertes_ne_sont_pas_cachees(client):
    """L'acquittement d'une alerte doit se refléter immédiatement dans l'UI."""
    resp = client.get("/api/alerts")
    assert resp.status_code == 200
    assert "s-maxage" not in resp.headers.get("cache-control", "")


def test_le_cron_n_est_jamais_cache(client, monkeypatch):
    """Un cache sur /api/cron/poll servirait une réponse au lieu de déclencher
    la collecte : le pinger croirait collecter alors que rien ne tourne."""
    import app.config as config
    import app.poller as poller

    async def fake_poll():
        return {"ok": True}

    monkeypatch.setattr(poller, "poll_once", fake_poll)
    monkeypatch.setattr(config, "CRON_SECRET", "")  # route ouverte pour le test
    resp = client.get("/api/cron/poll")
    assert resp.status_code == 200
    assert "s-maxage" not in resp.headers.get("cache-control", "")


def test_une_erreur_n_est_pas_cachee(client):
    """Un 4xx/5xx mis en cache resterait servi après correction."""
    resp = client.get("/api/global-metrics/history")  # metric manquant -> 422
    assert resp.status_code == 422
    assert "s-maxage" not in resp.headers.get("cache-control", "")
