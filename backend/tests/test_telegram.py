"""Bot Telegram : regroupement des fills, messages, lecture différée, webhook."""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

import pytest
from fastapi.testclient import TestClient

from app import config, db, telegram_bot as tg
from app.wallet_activity import group_actions, summarize

A = "0x" + "ab" * 20
B = "0x" + "cd" * 20
NOW = 1_800_000_000_000


def fill(t, *, coin="BTC", side="B", sz="1", px="100", start="0", pnl="0", liq=False, h="0x1"):
    f = {"coin": coin, "side": side, "sz": sz, "px": px, "time": t, "startPosition": start, "closedPnl": pnl, "hash": h}
    if liq:
        f["liquidation"] = {"method": "market"}
    return f


@pytest.fixture(autouse=True)
def token(monkeypatch):
    monkeypatch.setattr(config, "TELEGRAM_BOT_TOKEN", "123:test-token")


# --- Regroupement -------------------------------------------------------------------
def test_les_fills_rapproches_forment_une_action_et_un_silence_en_ouvre_une_autre():
    fills = [fill(0), fill(1_000, start="1"), fill(10_000, start="2")]
    actions = group_actions(A, fills)
    assert [(a.kind, a.fills) for a in actions] == [("open", 2), ("add", 1)]


def test_marches_distincts_actions_distinctes():
    actions = group_actions(A, [fill(0), fill(500, coin="ETH")])
    assert sorted(a.coin for a in actions) == ["BTC", "ETH"]


def test_qualification_cloture_bascule_liquidation():
    assert summarize(A, "BTC", [fill(0, side="A", sz="2", start="2")]).kind == "close"
    flip = summarize(A, "BTC", [fill(0, side="A", sz="3", start="2")])
    assert (flip.kind, flip.side) == ("flip", "short")
    assert summarize(A, "BTC", [fill(0, side="A", sz="1", start="2", liq=True)]).kind == "liquidation"


# --- Messages -----------------------------------------------------------------------
def test_le_libelle_utilisateur_est_echappe():
    a = summarize(A, "BTC", [fill(0, sz="500", px="100")])
    text = tg.format_action(a, "<b>pirate</b> & co")
    assert "&lt;b&gt;pirate&lt;/b&gt; &amp; co" in text
    assert f"/#/wallet/{A}" in text


def _watchers(*rows):
    return [{"address": a, "label": lbl, "chat_id": chat, "min_notional": mn} for a, lbl, chat, mn in rows]


def test_seuil_par_abonne_mais_les_liquidations_passent_toujours():
    small = summarize(A, "BTC", [fill(0, sz="1", px="100")])           # 100 $
    liq = summarize(A, "ETH", [fill(5, coin="ETH", side="A", sz="1", px="100", start="1", liq=True)])
    msgs = tg.build_wallet_messages([small, liq], _watchers((A, "Baleine", 1, 25_000), (A, "Baleine", 2, 0)))
    assert "ETH" in msgs[1] and "BTC" not in msgs[1]
    assert "BTC" in msgs[2] and "ETH" in msgs[2]


def test_une_conversation_reliee_deux_fois_ne_recoit_pas_de_doublon():
    a = summarize(A, "BTC", [fill(0, sz="1000")])
    msgs = tg.build_wallet_messages([a], _watchers((A, "X", 7, 0), (A, "Y", 7, 0)))
    assert msgs[7].count("BTC") == 1


def test_un_message_trop_long_est_resume():
    actions = [summarize(A, f"C{i}", [fill(i * 10_000, coin=f"C{i}", sz="1000")]) for i in range(14)]
    text = tg.build_wallet_messages(actions, _watchers((A, "X", 1, 0)))[1]
    assert "… et 4 autres mouvements." in text


# --- Cycle : lecture différée et curseurs ---------------------------------------------
class FakeHl:
    def __init__(self, data):
        self.data = data
        self.calls = []

    async def get_user_fills_since(self, user, start):
        self.calls.append((user, start))
        res = self.data[user]
        if isinstance(res, Exception):
            raise res
        return res


@asynccontextmanager
async def fake_client():
    yield None


@pytest.fixture
def cycle_db(monkeypatch):
    state = {"cursors": None, "sent": {}}
    monkeypatch.setattr(db, "tg_watch_batch", lambda limit: [{"address": A, "cursor_ms": 1_000}, {"address": B, "cursor_ms": 2_000}])
    monkeypatch.setattr(db, "tg_watchers", lambda addrs: _watchers((A, "Baleine", 42, 0)))
    monkeypatch.setattr(db, "tg_update_cursors", lambda rows: state.__setitem__("cursors", rows))

    async def send(c, chat_id, text):
        state["sent"][chat_id] = text
        return True

    monkeypatch.setattr(tg, "send", send)
    return state


def test_seuls_les_fills_poses_sont_traites_et_le_curseur_avance_jusqu_a_eux(cycle_db):
    settled = NOW - tg.SETTLE_MS - 1
    hl = FakeHl({A: [fill(settled, sz="1000"), fill(NOW - 2_000, coin="ETH", sz="1000")], B: RuntimeError("boom")})
    report = asyncio.run(tg.watch_wallets(hl, fake_client, NOW))

    assert hl.calls == [(A, 1_001), (B, 2_001)]  # curseur exclusif
    assert report == {"wallets": 2, "failed": 1, "actions": 1, "messages": 1}
    assert "BTC" in cycle_db["sent"][42] and "ETH" not in cycle_db["sent"][42]
    # B en échec : son curseur n'est pas touché, il sera relu au prochain cycle.
    assert cycle_db["cursors"] == [(A, settled, NOW)]


def test_sans_fill_le_curseur_reste_en_place(cycle_db):
    hl = FakeHl({A: [], B: []})
    report = asyncio.run(tg.watch_wallets(hl, fake_client, NOW))
    assert report["actions"] == 0 and cycle_db["sent"] == {}
    assert cycle_db["cursors"] == [(A, 1_000, NOW), (B, 2_000, NOW)]


def test_sans_token_le_bot_ne_fait_rien(monkeypatch):
    monkeypatch.setattr(config, "TELEGRAM_BOT_TOKEN", "")
    assert asyncio.run(tg.run_cycle(None, [], NOW)) is None


def test_alertes_critiques_seulement(monkeypatch):
    sent = {}
    monkeypatch.setattr(db, "tg_alert_chats", lambda: [5])

    async def send(c, chat_id, text):
        sent[chat_id] = text
        return True

    monkeypatch.setattr(tg, "send", send)
    rows = [("SOL", 0, "price_change", "warning", "SOL +6 %", {}, None, None), ("VINE", 0, "open_interest", "critical", "VINE <OI>", {}, None, None)]
    assert asyncio.run(tg.notify_alerts(fake_client, rows)) == 1
    assert "VINE &lt;OI&gt;" in sent[5] and "SOL" not in sent[5]


# --- Webhook ------------------------------------------------------------------------
@pytest.fixture
def api(monkeypatch):
    monkeypatch.setattr(db, "init_db", lambda: None)
    monkeypatch.setattr(config, "RUN_POLLER", False)
    from app.main import app

    with TestClient(app) as c:
        yield c


def test_webhook_refuse_sans_le_secret(api):
    assert api.post("/api/telegram/webhook", json={}).status_code == 401
    assert api.post("/api/telegram/webhook", json={}, headers={"X-Telegram-Bot-Api-Secret-Token": "faux"}).status_code == 401


def test_start_avec_un_code_relie_la_conversation(api, monkeypatch):
    linked, sent = [], []
    monkeypatch.setattr(db, "tg_link", lambda h, chat, now: linked.append((h, chat)) or True)
    monkeypatch.setattr(db, "tg_chat_wallet_count", lambda chat: 3)

    async def send(c, chat_id, text):
        sent.append((chat_id, text))
        return True

    monkeypatch.setattr(tg, "send", send)
    code = tg.new_code()
    resp = api.post(
        "/api/telegram/webhook",
        json={"message": {"chat": {"id": 99}, "text": f"/start {code}"}},
        headers={"X-Telegram-Bot-Api-Secret-Token": tg.webhook_secret()},
    )
    assert resp.status_code == 200
    assert linked == [(tg.hash_code(code), 99)]  # seule l'empreinte du code est stockée
    assert sent[0][0] == 99 and "Relié" in sent[0][1] and "3 pour" in sent[0][1]


def test_stop_delie_la_conversation(monkeypatch):
    calls = []
    monkeypatch.setattr(db, "tg_unlink_chat", lambda chat: calls.append(chat) or 1)

    async def send(c, chat_id, text):
        return True

    monkeypatch.setattr(tg, "send", send)
    assert asyncio.run(tg.handle_update(None, {"message": {"chat": {"id": 5}, "text": "/stop@hl_bot"}}, NOW)) == "stopped"
    assert calls == [5]


# --- Abonnement ---------------------------------------------------------------------
def test_les_routes_d_abonnement_exigent_un_code(api):
    assert api.get("/api/telegram/subscription").status_code == 401
    assert api.get("/api/telegram/subscription", headers={"X-Subscription-Code": "court"}).status_code == 401


def test_liste_suivie_normalisee(api, monkeypatch):
    saved = {}

    def update(h, mn, crit, wallets, now):
        saved.update(mn=mn, crit=crit, wallets=wallets)
        return True

    monkeypatch.setattr(db, "tg_update_sub", update)
    monkeypatch.setattr(db, "tg_get_sub", lambda h: {"chat_id": 1, "wallets": 2, "min_notional": 0.0, "critical_alerts": True})
    body = {"wallets": [{"address": A.upper().replace("0X", "0x"), "label": "  Baleine   MM "}, {"address": A, "label": "doublon"}, {"address": B}],
            "min_notional": -5, "critical_alerts": True}
    resp = api.put("/api/telegram/subscription", json=body, headers={"X-Subscription-Code": tg.new_code()})
    assert resp.status_code == 200
    assert saved["wallets"] == [(A, "Baleine MM"), (B, f"{B[:6]}…{B[-4:]}")]
    assert saved["mn"] == 0.0 and saved["crit"] is True


def test_adresse_invalide_refusee(api, monkeypatch):
    monkeypatch.setattr(db, "tg_update_sub", lambda *a: True)
    resp = api.put("/api/telegram/subscription", json={"wallets": [{"address": "0xpasunwallet"}]}, headers={"X-Subscription-Code": tg.new_code()})
    assert resp.status_code == 422
