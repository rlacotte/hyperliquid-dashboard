"""Marchés HIP-3 : collecte, track record segmenté, identifiants sensibles à la casse."""
from __future__ import annotations

import asyncio

import pytest

from app import config, poller
from app import track_record as tr
from app.routes.markets import _coin_id

H = 3600_000
D = 86400_000


def ctx(px="100", oi="0", vlm="0"):
    return {"markPx": px, "prevDayPx": px, "openInterest": oi, "dayNtlVlm": vlm, "funding": "0.0001", "oraclePx": px, "midPx": px, "dayBaseVlm": "0"}


class FakeHl:
    def __init__(self, dexs, by_dex, fail=()):
        self.dexs, self.by_dex, self.fail = dexs, by_dex, set(fail)

    async def get_perp_dexs(self):
        return self.dexs

    async def get_meta_and_asset_ctxs(self, dex=""):
        if dex in self.fail:
            raise TimeoutError("dex HS")
        names, ctxs = self.by_dex[dex]
        return [{"name": n, "szDecimals": 2, "maxLeverage": 10} for n in names], ctxs


@pytest.fixture
def kv(monkeypatch):
    store = {}
    monkeypatch.setattr(poller.db, "kv_get", lambda k: store.get(k))
    monkeypatch.setattr(poller.db, "kv_set", lambda k, ts, v: store.__setitem__(k, (ts, v)))
    return store


def test_seuls_les_marches_hip3_actifs_sont_suivis(kv):
    hl = FakeHl(["xyz"], {"xyz": (["xyz:TSLA", "xyz:TINY"], [ctx(vlm="5000000"), ctx(vlm="1000")])})
    assets, failed = asyncio.run(poller._hip3_assets(hl, 0))
    assert [a.coin for a in assets] == ["xyz:TSLA"]
    assert failed == []


def test_l_open_interest_suffit_a_qualifier_un_marche(kv):
    # 3 000 contrats × 100 $ = 300 k$ d'OI, volume nul.
    hl = FakeHl(["xyz"], {"xyz": (["xyz:GOLD"], [ctx(oi="3000")])})
    assets, _ = asyncio.run(poller._hip3_assets(hl, 0))
    assert [a.coin for a in assets] == ["xyz:GOLD"]


def test_un_dex_en_echec_n_interrompt_pas_les_autres(kv):
    hl = FakeHl(["xyz", "km"], {"xyz": (["xyz:TSLA"], [ctx(vlm="5000000")])}, fail={"km"})
    assets, failed = asyncio.run(poller._hip3_assets(hl, 0))
    assert [a.coin for a in assets] == ["xyz:TSLA"]
    assert failed == ["km"]


def test_balayage_horaire_puis_seulement_les_dex_actifs(kv):
    hl = FakeHl(
        ["xyz", "vide", "km"],
        {"xyz": (["xyz:TSLA"], [ctx(vlm="5000000")]), "vide": (["vide:X"], [ctx()]), "km": (["km:US500"], [ctx(vlm="9000000")])},
    )
    calls = []
    orig = hl.get_meta_and_asset_ctxs

    async def spy(dex=""):
        calls.append(dex)
        return await orig(dex)

    hl.get_meta_and_asset_ctxs = spy
    asyncio.run(poller._hip3_assets(hl, 0))          # balayage complet
    assert sorted(calls) == ["km", "vide", "xyz"]
    calls.clear()
    asyncio.run(poller._hip3_assets(hl, 10 * 60_000))  # cycle suivant : actifs seulement
    assert sorted(calls) == ["km", "xyz"]
    calls.clear()
    asyncio.run(poller._hip3_assets(hl, 2 * H))        # une heure plus tard : rebalayage
    assert sorted(calls) == ["km", "vide", "xyz"]


def test_un_dex_en_echec_au_balayage_reste_surveille(kv):
    hl = FakeHl(["xyz", "km"], {"xyz": (["xyz:TSLA"], [ctx(vlm="5000000")])}, fail={"km"})
    asyncio.run(poller._hip3_assets(hl, 0))
    assert kv[poller._HIP3_DEXS_KEY][1]["active"] == ["km", "xyz"]


def test_desactivable(kv, monkeypatch):
    monkeypatch.setattr(config, "HIP3_ENABLED", False)
    assert asyncio.run(poller._hip3_assets(FakeHl([], {}), 0)) == ([], [])


# --- Track record ------------------------------------------------------------------
def test_segment():
    assert tr.segment_of("xyz:TSLA") == "hip3"
    assert tr.segment_of("ETH") == "crypto"


def test_hip3_sans_reference_rendement_brut():
    candles = [(i * tr.CANDLE_MS, 100.0 + i) for i in range(200)]
    o = tr.outcome(candles, None, ts=0)
    assert o["btc_1h"] == 0.0  # référence constante
    assert o["ret_1h"] == pytest.approx(104 / 100 - 1)


def test_temoin_hip3_en_rendement_brut():
    hourly = [(i * H, 100.0 * (1.01 ** (i / 24))) for i in range(24 * 4)]
    rows = tr.baseline_from_candles("xyz:GOLD", hourly, None, tr.COARSE)
    assert rows and all(abs(x - 0.01) < 1e-3 for _, _, x in rows)


def test_groupes_separes_crypto_et_hip3():
    row = lambda coin: {"coin": coin, "ts": 0, "criterion": "funding_rate", "sign": 1, "ret_1h": 0.01, "btc_1h": 0.0,
                        "ret_4h": None, "btc_4h": None, "ret_24h": None, "btc_24h": None}
    groups = {g["segment"]: g for g in tr.aggregate([row("ETH"), row("xyz:NATGAS")])}
    assert set(groups) == {"crypto", "hip3"}
    assert groups["crypto"]["benchmark"] == "BTC"
    assert groups["hip3"]["benchmark"] is None


class Candles:
    def __init__(self):
        self.calls = []

    async def get_candles(self, coin, interval, lo, hi):
        self.calls.append(coin)
        step = tr.FINE["ms"] if interval == "15m" else tr.COARSE["ms"]
        return [{"t": lo + i * step, "o": "100"} for i in range((hi - lo) // step + 1)]


def test_lot_100_pourcent_hip3_ne_telecharge_pas_le_btc(monkeypatch):
    now = 300 * D
    pending = [{"alert_id": 1, "coin": "xyz:TSLA", "ts": now - 30 * H, "criterion": "price_change", "severity": "warning", "sign": 1}]
    monkeypatch.setattr(tr.db, "try_claim", lambda *a: True)
    monkeypatch.setattr(tr.db, "pending_alert_outcomes", lambda *a: pending)
    monkeypatch.setattr(tr.db, "upsert_alert_outcomes", lambda rows, ts: None)
    monkeypatch.setattr(tr.db, "insert_baseline_days", lambda rows: None)
    client = Candles()
    asyncio.run(tr.maybe_process(client, now))
    assert client.calls == ["xyz:TSLA"]


# --- Routes ----------------------------------------------------------------------
def test_identifiant_hip3_non_mis_en_majuscules():
    assert _coin_id("xyz:TSLA") == "xyz:TSLA"
    assert _coin_id("btc") == "BTC"
