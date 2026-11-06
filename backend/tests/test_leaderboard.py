"""Leaderboard distillé : profils et sélection.

Les profils reprennent les cas réels relevés à l'analyse du leaderboard : ce
sont eux qui faussent un classement par PnL brut.
"""
from __future__ import annotations

from app import leaderboard as lb


def row(addr="0xA", av=1_000_000, week=(0, 0, 0), month=(0, 0, 0), all_=(0, 0, 0), day=(0, 0, 0), name=None):
    def w(t):
        return {"pnl": str(t[0]), "roi": str(t[1]), "vlm": str(t[2])}
    return {
        "ethAddress": addr,
        "accountValue": str(av),
        "displayName": name,
        "windowPerformances": [["day", w(day)], ["week", w(week)], ["month", w(month)], ["allTime", w(all_)]],
    }


# --- classify ------------------------------------------------------------------
def test_pnl_sans_volume_est_passif():
    """+30 M$ avec un volume nul : le PnL ne vient pas du trading."""
    assert lb.classify(64e6, 1e6, 30e6, 72e6, vlm_month=0) == "passive"


def test_rotation_enorme_marge_infime_est_un_teneur_de_marche():
    """438× de rotation, 7 bp par dollar échangé (cas réel)."""
    av = 97.78e6
    assert lb.classify(av, 5e6, 31.65e6, 22e6, vlm_month=av * 438) == "market_maker"


def test_grosse_rotation_mais_grosse_marge_reste_directionnel():
    """Un trader très actif MAIS avec une vraie marge n'est pas un MM."""
    av = 1e6
    vlm = av * 300
    assert lb.classify(av, -1, vlm * 0.01, 5e6, vlm_month=vlm) != "market_maker"


def test_gagnant_du_mois_perdant_historique_est_un_rebond():
    """+24 M$ sur 30 j, −17 M$ sur tout l'historique (cas réel)."""
    assert lb.classify(8.49e6, 1e6, 24.41e6, -17.26e6, vlm_month=8.49e6 * 21) == "rebound"


def test_gagnant_partout_est_regulier():
    assert lb.classify(1e6, 1e4, 1e5, 1e6, vlm_month=2e7) == "consistent"


def test_le_reste_est_directionnel():
    assert lb.classify(1e6, -1e4, 1e5, 1e6, vlm_month=2e7) == "directional"


def test_compte_a_valeur_nulle_ne_divise_pas_par_zero():
    assert lb.classify(0, 0, 0, 0, vlm_month=0) in {"directional", "passive"}


# --- distill -------------------------------------------------------------------
def test_ecarte_les_petits_comptes_et_les_dormants():
    rows = [
        row("0xSmall", av=50_000, month=(1e4, 0.2, 1e6)),
        row("0xDormant", av=5e6),
        row("0xActive", av=5e6, month=(1e5, 0.02, 1e7), all_=(1e6, 0.2, 1e8)),
    ]
    out = lb.distill(rows)
    assert [r["a"] for r in out] == ["0xactive"]


def test_format_compact_et_adresse_normalisee():
    out = lb.distill([row("0xABCdef", av=2e6, week=(1, 0.01, 10), month=(5e4, 0.025, 1e7), all_=(1e5, 0.05, 1e8), name="whale")])
    r = out[0]
    assert r["a"] == "0xabcdef"
    assert r["n"] == "whale"
    assert r["pm"] == 5e4 and r["rm"] == 0.025 and r["vm"] == 1e7
    assert r["pr"] == "consistent"


def test_garde_l_union_des_axes(monkeypatch):
    """Un compte hors du top PnL mais au meilleur ROI doit être conservé."""
    monkeypatch.setattr(lb, "KEEP_TOP_PNL_MONTH", 1)
    monkeypatch.setattr(lb, "KEEP_TOP_ROI_MONTH", 1)
    monkeypatch.setattr(lb, "KEEP_TOP_PNL_ALL", 0)
    monkeypatch.setattr(lb, "KEEP_TOP_VALUE", 0)
    rows = [
        row("0xBigPnl", av=1e8, month=(1e7, 0.1, 1e9), all_=(1e7, 0.1, 1e9)),
        row("0xBigRoi", av=2e5, month=(4e5, 2.0, 1e7), all_=(4e5, 2.0, 1e7)),
        row("0xNeither", av=1e6, month=(1e3, 0.001, 1e7), all_=(1e3, 0.001, 1e7)),
    ]
    kept = {r["a"] for r in lb.distill(rows)}
    assert kept == {"0xbigpnl", "0xbigroi"}


def test_trie_par_pnl_30j():
    rows = [row(f"0x{i}", av=1e6, month=(i * 1000, 0.01, 1e7), all_=(1, 0, 1e7)) for i in range(5)]
    pm = [r["pm"] for r in lb.distill(rows)]
    assert pm == sorted(pm, reverse=True)


def test_fenetre_absente_ne_casse_pas():
    r = {"ethAddress": "0xX", "accountValue": "1000000", "windowPerformances": [["month", {"pnl": "5", "roi": "0", "vlm": "100"}]]}
    assert lb.distill([r])[0]["pa"] == 0


# --- maybe_refresh : réservation anti-doublon ----------------------------------
import asyncio


def _fake_kv(monkeypatch, initial):
    store = dict(initial)
    monkeypatch.setattr(lb.db, "kv_get", lambda k: store.get(k))
    monkeypatch.setattr(lb.db, "kv_set", lambda k, ts, v: store.__setitem__(k, (ts, v)))
    monkeypatch.setattr(lb.db, "insert_leaderboard_snapshot", lambda day, rows: len(rows))
    return store


def test_une_reservation_fraiche_empeche_un_second_telechargement(monkeypatch):
    now = 10_000_000
    _fake_kv(monkeypatch, {lb.CLAIM_KEY: (now - 30_000, {})})  # réservé il y a 30 s
    calls = []

    async def fetch(_client):
        calls.append(1)
        return []

    monkeypatch.setattr(lb, "fetch_rows", fetch)
    assert asyncio.run(lb.maybe_refresh(None, now)) is None
    assert calls == []


def test_une_reservation_abandonnee_expire(monkeypatch):
    now = 10_000_000
    store = _fake_kv(monkeypatch, {lb.CLAIM_KEY: (now - (lb.CLAIM_TTL_SEC + 1) * 1000, {})})

    async def fetch(_client):
        return [row("0xA", av=2e6, month=(1e5, 0.05, 1e7), all_=(1e6, 0.5, 1e8))]

    monkeypatch.setattr(lb, "fetch_rows", fetch)
    info = asyncio.run(lb.maybe_refresh(None, now))
    assert info["kept"] == 1
    assert store[lb.KV_KEY][1]["rows"][0]["a"] == "0xa"


def test_rafraichi_recemment_ne_refait_rien(monkeypatch):
    now = 10_000_000
    _fake_kv(monkeypatch, {lb.KV_KEY: (now - 60_000, {"total": 0, "rows": []})})

    async def fetch(_client):
        raise AssertionError("ne doit pas être appelé")

    monkeypatch.setattr(lb, "fetch_rows", fetch)
    assert asyncio.run(lb.maybe_refresh(None, now)) is None
