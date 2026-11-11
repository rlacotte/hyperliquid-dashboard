"""Historique des perps pour le simulateur de scénarios BTC."""
from __future__ import annotations

import asyncio
import math

from app import db, scenarios

DAY = scenarios.DAY_MS


def candle(day, close, volume=0):
    """`volume` en unités du coin, comme l'API : le dollar = volume × clôture."""
    return {"t": day * DAY, "c": str(close), "v": str(volume)}


# --- Fusion des bougies --------------------------------------------------------------
def test_la_bougie_du_jour_en_cours_est_ignoree():
    first, closes, volumes = scenarios.merge_history(None, [candle(10, 100, 2), candle(11, 110, 1), candle(12, 999, 9)], 11, False)
    assert (first, closes) == (10, [100.0, 110.0])
    assert volumes == [200, 110]                 # en dollars


def test_un_jour_sans_bougie_reprend_le_dernier_cours_jusqu_a_la_cible():
    first, closes, volumes = scenarios.merge_history(None, [candle(10, 100, 1), candle(12, 120, 1)], 14, False)
    assert closes == [100.0, 100.0, 120.0, 120.0, 120.0]
    assert volumes == [100, 0, 120, 0, 0]        # pas de bougie : pas d'échange


def test_un_coin_retire_s_arrete_a_sa_derniere_bougie():
    first, closes, _ = scenarios.merge_history(None, [candle(10, 100), candle(11, 90)], 30, True)
    assert closes == [100.0, 90.0]


def test_les_nouvelles_bougies_completent_et_corrigent_l_existant():
    prev = {"first_day": 10, "closes": [100.0, 110.0], "volumes": [5, 6]}
    first, closes, volumes = scenarios.merge_history(prev, [candle(11, 111, 1), candle(12, 120, 1)], 12, False)
    assert (first, closes) == (10, [100.0, 111.0, 120.0])
    assert volumes == [5, 111, 120]


def test_sans_aucun_cours_rien():
    assert scenarios.merge_history(None, [], 12, False) is None
    assert scenarios.merge_history(None, [{"t": "x"}, candle(5, 0)], 12, False) is None


# --- Rendements hebdomadaires --------------------------------------------------------
def test_semaines_ancrees_sur_le_dernier_jour_du_plus_ancien_au_plus_recent():
    closes = [100.0] * 8 + [110.0] * 7          # jours 0..14 ; frontières 0, 7, 14
    rets, liq, e = scenarios.weekly_series(0, closes, [0.0] * 15, 14, 10)
    assert e == 0
    assert rets == [0, round(math.log(1.1) * 10_000)]
    assert liq == [scenarios.LIQ_UNKNOWN] * 2   # aucun volume : historique reconstitué


def test_une_semaine_incomplete_au_debut_n_est_pas_rendue():
    rets, _, _ = scenarios.weekly_series(3, [100.0] * 12, [0.0] * 12, 14, 10)   # jours 3..14 : seule la semaine 7→14 est entière
    assert rets == [0]


def test_coin_retire_les_semaines_manquantes_a_la_fin_sont_comptees():
    closes = [100.0] * 8 + [50.0]               # jours 0..8, retiré ensuite
    rets, _, e = scenarios.weekly_series(0, closes, [0.0] * 9, 21, 10)
    assert e == 2                               # semaines finissant aux jours 21 et 14
    assert rets == [0]                          # semaine 0→7


def test_liquidite_moyenne_sur_30_jours_inconnue_avant_le_premier_volume():
    # 70 jours ; volume nul les 40 premiers (historique reconstitué), puis 1 M$ par jour.
    volumes = [0.0] * 40 + [1e6] * 30
    rets, liq, _ = scenarios.weekly_series(0, [100.0] * 70, volumes, 69, 20)
    # Semaines finissant aux jours 13, 20, …, 69. Volume réel à partir du jour 40 :
    # la première semaine notée est celle qui finit au jour 48 (≥ 40 + 6).
    assert len(rets) == 9
    assert liq[:5] == [scenarios.LIQ_UNKNOWN] * 5
    assert liq[5:] == [60, 60, 60, 60]          # 10 × log10(1 M$), les jours sans volume d'avant ne diluent pas


def test_code_de_liquidite():
    assert scenarios.liquidity_code([5e5] * 40, 0, 39) == 57
    assert scenarios.liquidity_code([0.0] * 40, None, 39) == scenarios.LIQ_UNKNOWN


def test_matrice_btc_en_tete_et_drapeaux():
    rows = [
        {"coin": "ETH", "first_day": 0, "delisted": False, "closes": [10.0] * 15, "volumes": [1e7] * 15},
        {"coin": "BTC", "first_day": 0, "delisted": False, "closes": [100.0] * 15, "volumes": [1e9] * 15},
        {"coin": "OLD", "first_day": 0, "delisted": True, "closes": [1.0] * 9, "volumes": []},
        {"coin": "NEW", "first_day": 12, "delisted": False, "closes": [1.0] * 3, "volumes": [1.0] * 3},
    ]
    m = scenarios.build_matrix(rows, 14)
    assert [c["c"] for c in m["coins"]] == ["BTC", "ETH", "OLD"]      # NEW : moins d'une semaine
    assert m["weeks"] == 2
    old = m["coins"][2]
    assert old["x"] is True and old["e"] == 1 and old["r"] == [0] and old["v"] == [scenarios.LIQ_UNKNOWN]
    assert m["coins"][1]["v"] == [70, 70]       # ETH : 10 M$ par jour


# --- Passe de relevé -----------------------------------------------------------------
class FakeHl:
    def __init__(self, data):
        self.data = data
        self.calls = []

    async def get_candles(self, coin, interval, start):
        self.calls.append((coin, interval, start))
        res = self.data.get(coin, [])
        if isinstance(res, Exception):
            raise res
        return res


def setup_db(monkeypatch, status=None, existing=None, kv=None):
    state = {"upserts": [], "kv": dict(kv or {}), "kv_reads": []}
    monkeypatch.setattr(scenarios, "_published_day", None)
    monkeypatch.setattr(db, "price_history_status", lambda: dict(status or {}))
    monkeypatch.setattr(db, "price_history_get", lambda coins: {c: v for c, v in (existing or {}).items() if c in coins})
    monkeypatch.setattr(db, "price_history_upsert", lambda rows: state["upserts"].extend(rows))
    monkeypatch.setattr(db, "price_history_all", lambda: list((existing or {}).values()))
    monkeypatch.setattr(db, "kv_get", lambda k: (state["kv_reads"].append(k), state["kv"].get(k))[1])
    monkeypatch.setattr(db, "kv_set", lambda k, ts, v: state["kv"].__setitem__(k, (ts, v)))
    return state


NOW = 100 * DAY + 3600_000      # jour 100, 01:00 UTC → dernier jour complet : 99
UNIVERSE = [{"name": "ETH"}, {"name": "BTC"}, {"name": "DEAD", "isDelisted": True}, {"name": "xyz:TSLA"}]


def test_premier_passage_btc_d_abord_et_hip3_ignore(monkeypatch):
    state = setup_db(monkeypatch)
    hl = FakeHl({"BTC": [candle(98, 100, 1), candle(99, 110, 1), candle(100, 120, 1)], "ETH": RuntimeError("boom")})
    out = asyncio.run(scenarios.process(hl, UNIVERSE, NOW, batch=2))
    assert [c[0] for c in hl.calls] == ["BTC", "DEAD"]          # BTC en tête ; xyz:TSLA hors périmètre
    assert out == {"updated": 2, "failed": [], "remaining": 1}
    btc = next(r for r in state["upserts"] if r["coin"] == "BTC")
    assert btc["closes"] == [100.0, 110.0] and btc["updated_day"] == 99 and btc["tried_day"] == 99
    assert btc["volumes"] == [100, 110]


def test_un_echec_est_marque_essaye_sans_perdre_l_historique(monkeypatch):
    existing = {"ETH": {"coin": "ETH", "first_day": 90, "updated_day": 98, "delisted": False, "closes": [1.0] * 9, "volumes": [7] * 9}}
    status = {"ETH": {"updated_day": 98, "tried_day": 98, "delisted": False}, "BTC": {"updated_day": 99, "tried_day": 99, "delisted": False},
              "DEAD": {"updated_day": 50, "tried_day": 60, "delisted": True}}
    state = setup_db(monkeypatch, status, existing)
    hl = FakeHl({"ETH": RuntimeError("boom")})
    out = asyncio.run(scenarios.process(hl, UNIVERSE, NOW))
    assert hl.calls == [("ETH", "1d", 96 * DAY)]                # reprise 2 jours avant ; DEAD déjà relevé, jamais repris
    assert out["failed"] == ["ETH"]
    row = state["upserts"][0]
    assert row["closes"] == [1.0] * 9 and row["volumes"] == [7] * 9 and row["updated_day"] == 98 and row["tried_day"] == 99


def test_passe_finie_la_matrice_est_publiee_une_fois_par_jour(monkeypatch):
    rows = {
        "BTC": {"coin": "BTC", "first_day": 80, "updated_day": 99, "delisted": False, "closes": [100.0] * 20, "volumes": [1e9] * 20},
        "ETH": {"coin": "ETH", "first_day": 80, "updated_day": 99, "delisted": False, "closes": [10.0] * 20, "volumes": [1e8] * 20},
    }
    status = {c: {"updated_day": 99, "tried_day": 99, "delisted": False} for c in ("BTC", "ETH")}
    status["DEAD"] = {"updated_day": 0, "tried_day": 99, "delisted": True}
    state = setup_db(monkeypatch, status, rows)
    hl = FakeHl({})
    out = asyncio.run(scenarios.process(hl, UNIVERSE, NOW))
    assert hl.calls == [] and out == {"matrix": 2, "weeks": 2}
    assert state["kv"]["scenario_matrix"][1]["anchor_day"] == 99
    assert state["kv"]["scenario_matrix_day"][1] == {"day": 99}
    state["kv_reads"].clear()
    assert asyncio.run(scenarios.process(hl, UNIVERSE, NOW)) is None     # déjà publiée pour ce jour
    assert state["kv_reads"] == []                                       # instance chaude : plus aucune lecture


def test_une_instance_neuve_reconnait_la_matrice_du_jour_sans_la_relire(monkeypatch):
    state = setup_db(monkeypatch, kv={"scenario_matrix_day": (NOW, {"day": 99})})
    hl = FakeHl({})
    assert asyncio.run(scenarios.process(hl, UNIVERSE, NOW)) is None
    assert state["kv_reads"] == ["scenario_matrix_day"]                  # la petite clé, jamais la matrice
    assert hl.calls == []


def test_juste_apres_minuit_on_attend(monkeypatch):
    setup_db(monkeypatch)
    assert asyncio.run(scenarios.process(FakeHl({}), UNIVERSE, 100 * DAY + 60_000)) is None
