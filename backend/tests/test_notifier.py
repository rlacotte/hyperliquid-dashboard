"""Notifications sortantes : filtrage, formatage, no-op, isolation des échecs."""
from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from app import config, notifier


def row(coin: str, severity: str, message: str) -> tuple:
    """Tuple d'insertion au format _CycleWriter."""
    return (coin, 0, "funding_rate", severity, message, {}, None, None)


# --- Filtrage -----------------------------------------------------------------
def test_seuil_par_defaut_ne_retient_que_critical(monkeypatch):
    monkeypatch.setattr(config, "NOTIFY_MIN_SEVERITY", "critical")
    rows = [row("A", "info", "i"), row("B", "warning", "w"), row("C", "critical", "c")]
    assert [r[0] for r in notifier.select_notable(rows)] == ["C"]


def test_seuil_warning_inclut_warning_et_critical(monkeypatch):
    monkeypatch.setattr(config, "NOTIFY_MIN_SEVERITY", "warning")
    rows = [row("A", "info", "i"), row("B", "warning", "w"), row("C", "critical", "c")]
    assert [r[0] for r in notifier.select_notable(rows)] == ["B", "C"]


def test_seuil_inconnu_retombe_sur_critical(monkeypatch):
    """Une valeur de config invalide ne doit pas ouvrir les vannes."""
    monkeypatch.setattr(config, "NOTIFY_MIN_SEVERITY", "tout")
    rows = [row("B", "warning", "w"), row("C", "critical", "c")]
    assert [r[0] for r in notifier.select_notable(rows)] == ["C"]


# --- Formatage ------------------------------------------------------------------
def test_message_groupe_et_trie_par_severite():
    rows = [row("A", "warning", "alerte warning"), row("B", "critical", "alerte critique")]
    text = notifier.format_message(rows)
    lines = text.split("\n")
    assert "2 nouvelle(s) alerte(s)" in lines[0]
    # La critique passe en premier même si insérée en second
    assert "alerte critique" in lines[1]
    assert "alerte warning" in lines[2]


# --- Envoi ----------------------------------------------------------------------
class Transport(httpx.MockTransport):
    """Transport httpx qui enregistre les requêtes sorties."""

    def __init__(self, fail_hosts: set[str] | None = None):
        self.requests: list[httpx.Request] = []
        self.fail_hosts = fail_hosts or set()

        def handler(request: httpx.Request) -> httpx.Response:
            self.requests.append(request)
            if request.url.host in self.fail_hosts:
                return httpx.Response(500)
            return httpx.Response(200, json={"ok": True})

        super().__init__(handler)


@pytest.fixture
def transport(monkeypatch):
    t = Transport()
    orig = httpx.AsyncClient

    def patched(*args, **kwargs):
        kwargs["transport"] = t
        return orig(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", patched)
    return t


def test_no_op_sans_configuration(monkeypatch, transport):
    monkeypatch.setattr(config, "TELEGRAM_BOT_TOKEN", "")
    monkeypatch.setattr(config, "TELEGRAM_CHAT_ID", "")
    monkeypatch.setattr(config, "DISCORD_WEBHOOK_URL", "")

    report = asyncio.run(notifier.notify_new_alerts([row("A", "critical", "x")]))

    assert report == {}
    assert transport.requests == []


def test_envoi_telegram_et_discord(monkeypatch, transport):
    monkeypatch.setattr(config, "NOTIFY_MIN_SEVERITY", "critical")
    monkeypatch.setattr(config, "TELEGRAM_BOT_TOKEN", "tok")
    monkeypatch.setattr(config, "TELEGRAM_CHAT_ID", "42")
    monkeypatch.setattr(config, "DISCORD_WEBHOOK_URL", "https://discord.test/webhook")

    report = asyncio.run(notifier.notify_new_alerts([row("A", "critical", "BTC funding extrême")]))

    assert report == {"telegram": True, "discord": True}
    assert len(transport.requests) == 2
    tg = json.loads(transport.requests[0].content)
    assert tg["chat_id"] == "42" and "BTC funding extrême" in tg["text"]


def test_echec_d_un_canal_n_empeche_pas_l_autre(monkeypatch):
    """Telegram en panne -> Discord doit quand même partir, et inversement.

    C'est la propriété qui évite qu'une API tierce HS rende les alertes muettes
    partout à la fois.
    """
    t = Transport(fail_hosts={"api.telegram.org"})
    orig = httpx.AsyncClient
    monkeypatch.setattr(
        httpx, "AsyncClient", lambda *a, **k: orig(*a, **{**k, "transport": t})
    )
    monkeypatch.setattr(config, "NOTIFY_MIN_SEVERITY", "critical")
    monkeypatch.setattr(config, "TELEGRAM_BOT_TOKEN", "tok")
    monkeypatch.setattr(config, "TELEGRAM_CHAT_ID", "42")
    monkeypatch.setattr(config, "DISCORD_WEBHOOK_URL", "https://discord.test/webhook")

    report = asyncio.run(notifier.notify_new_alerts([row("A", "critical", "x")]))

    assert report == {"telegram": False, "discord": True}


def test_rien_a_notifier_aucun_appel(monkeypatch, transport):
    """Que des warnings sous un seuil critical : pas d'appel réseau du tout."""
    monkeypatch.setattr(config, "NOTIFY_MIN_SEVERITY", "critical")
    monkeypatch.setattr(config, "TELEGRAM_BOT_TOKEN", "tok")
    monkeypatch.setattr(config, "TELEGRAM_CHAT_ID", "42")

    report = asyncio.run(notifier.notify_new_alerts([row("A", "warning", "w")]))

    assert report == {}
    assert transport.requests == []
