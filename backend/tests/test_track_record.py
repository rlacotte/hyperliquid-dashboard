"""Track record des alertes : calcul sans regard vers le futur, agrégats, orchestration."""
from __future__ import annotations

import asyncio

import pytest

from app import track_record as tr

M = 60_000
Q = tr.CANDLE_MS  # 15 min
H = 3600_000


def candles(start, n, px_fn):
    """Bougies de 15 min : [(t, ouverture)]."""
    return [(start + i * Q, px_fn(i)) for i in range(n)]


# --- Sens de l'alerte -----------------------------------------------------------
@pytest.mark.parametrize(
    "criterion, details, direction, expected",
    [
        ("price_change", {"delta_pct": -0.05}, None, -1),
        ("price_change", {"delta_pct": 0.08}, None, 1),
        ("open_interest", {"delta_pct": 0.13}, None, 1),
        ("funding_rate", {"funding": -0.0013}, None, -1),
        ("funding_rate", {"funding": 0.002}, None, 1),
        ("confluence", {}, "bullish", 1),
        ("confluence", {}, "bearish", -1),
        ("confluence", {}, "neutral", 0),
        ("volume", {"multiple": 4.2}, None, 0),
        ("price_change", {}, None, 0),
        ("funding_rate", {"funding": "pas un nombre"}, None, 0),
    ],
)
def test_sens(criterion, details, direction, expected):
    assert tr.signal_sign(criterion, details, direction) == expected


# --- Pas de regard vers le futur ----------------------------------------------------
def test_le_prix_de_reference_est_la_bougie_suivant_l_alerte():
    """Alerte à 10:07 : la référence est l'ouverture de 10:15, pas celle de 10:00
    (qui précède l'alerte : on ne pouvait pas y entrer)."""
    c = [(0, 100.0), (Q, 110.0), (2 * Q, 120.0)]
    assert tr.open_after(c, 7 * M) == 110.0


def test_alerte_pile_sur_une_bougie():
    c = [(0, 100.0), (Q, 110.0)]
    assert tr.open_after(c, Q) == 110.0


def test_horizon_pas_encore_atteint():
    c = [(0, 100.0), (Q, 110.0)]
    assert tr.open_after(c, 5 * Q) is None


def test_trou_dans_les_bougies_pas_de_mesure_fausse():
    """Une bougie très éloignée (marché suspendu) ne doit pas servir de prix."""
    c = [(0, 100.0), (10 * Q, 200.0)]
    assert tr.open_after(c, Q) is None


def test_rendements_et_reference_marche():
    # Coin : +1 % par bougie ; marché (BTC) : plat.
    coin = candles(0, 200, lambda i: 100 * (1.01 ** i))
    btc = candles(0, 200, lambda i: 50_000.0)
    o = tr.outcome(coin, btc, ts=1 * M)  # référence = bougie 1
    assert o["px0"] == pytest.approx(101.0)
    # 1 h plus tard : bougie 5 → +4 bougies
    assert o["ret_1h"] == pytest.approx(1.01 ** 4 - 1)
    assert o["btc_1h"] == pytest.approx(0.0)
    assert o["ret_24h"] == pytest.approx(1.01 ** 96 - 1)
    assert o["complete"] is True


def test_resultat_incomplet_si_24h_pas_encore_ecoulees():
    coin = candles(0, 20, lambda i: 100.0)  # 5 h de bougies seulement
    o = tr.outcome(coin, coin, ts=0)
    assert o["ret_1h"] == 0.0
    assert o["ret_4h"] == 0.0
    assert o["ret_24h"] is None
    assert o["complete"] is False


# --- Agrégats ------------------------------------------------------------------------
def row(criterion, sign, r1, b1=0.0, coin="ETH", ts=0):
    return {"coin": coin, "ts": ts, "criterion": criterion, "sign": sign, "ret_1h": r1, "btc_1h": b1,
            "ret_4h": None, "btc_4h": None, "ret_24h": None, "btc_24h": None}


def test_agrege_par_critere_et_sens():
    rows = [row("price_change", 1, 0.02), row("price_change", 1, -0.01), row("price_change", -1, -0.03)]
    groups = {(g["criterion"], g["sign"]): g for g in tr.aggregate(rows)}
    up = groups[("price_change", 1)]["horizons"]["1h"]
    assert up["n"] == 2
    assert up["p_up"] == 0.5
    assert up["mean"] == pytest.approx(0.005)
    assert groups[("price_change", -1)]["horizons"]["1h"]["p_up"] == 0.0


def test_le_relatif_au_btc_isole_le_mouvement_de_marche():
    """Tout baisse de 8 % mais le coin seulement de 3 % : en absolu c'est une
    baisse, en relatif il a fait MIEUX que le marché."""
    g = tr.aggregate([row("funding_rate", -1, -0.03, b1=-0.08)])[0]["horizons"]["1h"]
    assert g["mean"] == pytest.approx(-0.03)
    assert g["mean_vs_btc"] == pytest.approx(0.05)
    assert g["p_beat_btc"] == 1.0


def test_le_btc_est_exclu_de_la_comparaison_a_lui_meme():
    g = tr.aggregate([row("volume", 0, 0.01, b1=0.01, coin="BTC")])[0]["horizons"]["1h"]
    assert g["n"] == 1
    assert g["n_vs_btc"] == 0
    assert g["mean_vs_btc"] is None


def test_horizon_sans_donnees():
    g = tr.aggregate([row("volume", 0, 0.01)])[0]["horizons"]["24h"]
    assert g == {"n": 0}


# --- Orchestration --------------------------------------------------------------------
class FakeClient:
    def __init__(self):
        self.calls = []
        self.intervals = []

    async def get_candles(self, coin, interval, lo, hi):
        self.calls.append(coin)
        self.intervals.append((coin, interval))
        step = tr.FINE["ms"] if interval == "15m" else tr.COARSE["ms"]
        n = (hi - lo) // step + 1
        return [{"t": lo + i * step, "o": "100"} for i in range(n)]


def test_lot_borne_et_resultats_enregistres(monkeypatch):
    now = 100 * 86400_000
    pending = [
        {"alert_id": i, "coin": c, "ts": now - 30 * H + i * M, "criterion": "price_change", "severity": "warning", "sign": 1}
        for i, c in enumerate(["AAA", "BBB", "CCC", "DDD", "EEE"])
    ]
    saved = []
    monkeypatch.setattr(tr.db, "try_claim", lambda *a: True)
    monkeypatch.setattr(tr.db, "pending_alert_outcomes", lambda *a: pending)
    monkeypatch.setattr(tr.db, "upsert_alert_outcomes", lambda rows, ts: saved.extend(rows))
    client = FakeClient()

    info = asyncio.run(tr.maybe_process(client, now))

    # Au plus COINS_PER_PASS coins par passe (+ le marché de référence).
    assert info["processed"] == tr.COINS_PER_PASS
    assert client.calls[0] == tr.MARKET
    assert len(client.calls) == 1 + tr.COINS_PER_PASS
    assert {r["coin"] for r in saved} == {"AAA", "BBB", "CCC"}  # les plus anciens d'abord
    assert all(r["complete"] for r in saved)


def test_passe_recente_ne_refait_rien(monkeypatch):
    monkeypatch.setattr(tr.db, "try_claim", lambda *a: False)

    def boom(*a):
        raise AssertionError("ne doit pas interroger la base")

    monkeypatch.setattr(tr.db, "pending_alert_outcomes", boom)
    assert asyncio.run(tr.maybe_process(FakeClient(), 0)) is None


def test_le_marche_n_est_pas_telecharge_deux_fois(monkeypatch):
    now = 100 * 86400_000
    pending = [{"alert_id": 1, "coin": "BTC", "ts": now - 30 * H, "criterion": "volume", "severity": "warning", "sign": 0}]
    monkeypatch.setattr(tr.db, "try_claim", lambda *a: True)
    monkeypatch.setattr(tr.db, "pending_alert_outcomes", lambda *a: pending)
    monkeypatch.setattr(tr.db, "upsert_alert_outcomes", lambda rows, ts: None)
    client = FakeClient()
    asyncio.run(tr.maybe_process(client, now))
    assert client.calls == ["BTC"]


# --- Double résolution ------------------------------------------------------------
def test_resolution_selon_l_age():
    now = 300 * 86400_000
    assert tr.resolution_for(now - 10 * 86400_000, now) is tr.FINE
    assert tr.resolution_for(now - 80 * 86400_000, now) is tr.COARSE


def test_resolution_grossiere_ne_produit_pas_d_horizon_1h():
    """À 1 h de résolution, le prix d'entrée peut être décalé de 60 min : une
    mesure à 1 h serait fausse, elle ne doit pas exister."""
    hourly = [(i * H, 100.0 + i) for i in range(60)]
    o = tr.outcome(hourly, hourly, ts=10 * M, res=tr.COARSE)
    assert o["ret_1h"] is None
    assert o["ret_4h"] is not None
    assert o["ret_24h"] is not None
    assert o["resolution_min"] == 60
    assert o["complete"] is True


def test_tolerance_de_trou_suit_la_resolution():
    """Une bougie horaire à 50 min n'est pas un trou en résolution 1 h."""
    hourly = [(0, 100.0), (H, 101.0)]
    assert tr.open_after(hourly, 10 * M, tr.COARSE["ms"]) == 101.0
    assert tr.open_after(hourly, 10 * M, tr.FINE["ms"]) is None


def test_lot_mixte_demande_les_bonnes_resolutions(monkeypatch):
    now = 300 * 86400_000
    pending = [
        {"alert_id": 1, "coin": "OLD", "ts": now - 120 * 86400_000, "criterion": "price_change", "severity": "warning", "sign": 1},
        {"alert_id": 2, "coin": "NEW", "ts": now - 30 * H, "criterion": "price_change", "severity": "warning", "sign": 1},
    ]
    saved = []
    monkeypatch.setattr(tr.db, "try_claim", lambda *a: True)
    monkeypatch.setattr(tr.db, "pending_alert_outcomes", lambda *a: pending)
    monkeypatch.setattr(tr.db, "upsert_alert_outcomes", lambda rows, ts: saved.extend(rows))
    client = FakeClient()
    asyncio.run(tr.maybe_process(client, now))

    assert ("OLD", "1h") in client.intervals
    assert ("NEW", "15m") in client.intervals
    # Marché de référence téléchargé une fois PAR résolution.
    assert sorted(i for c, i in client.intervals if c == tr.MARKET) == ["15m", "1h"]
    by_id = {r["alert_id"]: r for r in saved}
    assert by_id[1]["ret_1h"] is None and by_id[1]["ret_4h"] is not None
    assert by_id[2]["ret_1h"] is not None


# --- Grappes : effectif effectif -------------------------------------------------
def test_alertes_d_un_meme_coin_le_meme_jour_forment_une_seule_grappe():
    """85 alertes d'un seul coin sur une journée = 1 observation, pas 85."""
    rows = [row("price_change", -1, 0.05, b1=0.0, coin="SOL", ts=i * M) for i in range(85)]
    h = tr.aggregate(rows)[0]["horizons"]["1h"]
    assert h["n_vs_btc"] == 85
    assert h["n_clusters"] == 1


def test_grappes_par_coin_et_par_jour():
    D = 86400_000
    rows = [
        row("volume", 0, 0.02, coin="A", ts=0),
        row("volume", 0, 0.04, coin="A", ts=1000),      # même grappe que la précédente
        row("volume", 0, -0.01, coin="A", ts=D + 5),    # autre jour
        row("volume", 0, -0.03, coin="B", ts=0),        # autre coin
    ]
    h = tr.aggregate(rows)[0]["horizons"]["1h"]
    assert h["n_clusters"] == 3
    # Moyennes de grappe : +3 %, −1 %, −3 % → 1 grappe sur 3 bat le BTC.
    assert h["p_beat_btc_clusters"] == pytest.approx(1 / 3, abs=1e-4)
    assert h["mean_vs_btc_clusters"] == pytest.approx((0.03 - 0.01 - 0.03) / 3, abs=1e-6)
