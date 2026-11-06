"""Garde anti-doublon de la route de collecte."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import config, db
from app.routes import cron


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(db, "init_db", lambda: None)
    monkeypatch.setattr(config, "CRON_SECRET", "s3cret")
    # Un .env local peut activer le poller in-process, que le lifespan
    # démarrerait et qui appellerait poll_once en plus : test faussé.
    monkeypatch.setattr(config, "RUN_POLLER", False)
    calls = {"poll": 0}

    async def fake_poll():
        calls["poll"] += 1
        return {"ok": True}

    import app.poller as poller

    monkeypatch.setattr(poller, "poll_once", fake_poll)
    from app.main import app

    with TestClient(app) as c:
        c.calls = calls
        yield c


AUTH = {"Authorization": "Bearer s3cret"}


def test_creneau_libre_lance_le_cycle(client, monkeypatch):
    monkeypatch.setattr(db, "try_claim", lambda key, now, interval: True)
    resp = client.get("/api/cron/poll", headers=AUTH)
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}
    assert client.calls["poll"] == 1


def test_doublon_ignore_sans_cycle(client, monkeypatch):
    """Un second appel dans les 20 s ne doit rien recalculer."""
    monkeypatch.setattr(db, "try_claim", lambda key, now, interval: False)
    resp = client.get("/api/cron/poll", headers=AUTH)
    assert resp.status_code == 200
    assert resp.json()["skipped"] is True
    assert client.calls["poll"] == 0


def test_intervalle_transmis_a_la_reservation(client, monkeypatch):
    seen = {}

    def claim(key, now, interval):
        seen.update(key=key, interval=interval)
        return True

    monkeypatch.setattr(db, "try_claim", claim)
    client.get("/api/cron/poll", headers=AUTH)
    assert seen == {"key": "poll_claim", "interval": cron.MIN_POLL_INTERVAL_MS}


def test_sans_secret_refuse_avant_toute_reservation(client, monkeypatch):
    def claim(*a):
        raise AssertionError("ne doit pas réserver un créneau pour un appel non autorisé")

    monkeypatch.setattr(db, "try_claim", claim)
    assert client.get("/api/cron/poll").status_code == 401
