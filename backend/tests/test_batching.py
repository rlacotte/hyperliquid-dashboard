"""Garantie de groupage des requêtes.

Le portage vers une base distante repose entièrement sur ce point : l'évaluation
d'un cycle doit coûter un nombre de requêtes CONSTANT, pas proportionnel au
nombre de coins. Une régression ici ne casse aucun comportement visible — elle
fait juste passer le cycle de 3 s à plusieurs minutes, au-delà du budget d'une
fonction serverless. D'où un test dédié.
"""
from __future__ import annotations

from app import alert_engine

from .conftest import make_asset, make_ctx

COINS = [f"C{i}" for i in range(50)]


def test_les_ecritures_tiennent_en_un_appel_par_type(spy):
    assets = [
        make_asset(c, mark_px=120.0, funding=0.002, open_interest=1500.0) for c in COINS
    ]
    ctx = make_ctx(*COINS)

    alert_engine.evaluate_all(assets, ctx)

    # 50 coins x 5 critères, tous déclenchés
    assert len(spy.inserts) == 250
    # ... mais un seul aller-retour, quel que soit le nombre de coins
    assert spy.calls["insert"] == 1


def test_les_resolutions_tiennent_en_un_appel(spy, active_alerts):
    for c in COINS:
        active_alerts[(c, "price_change")] = {"id": 1, "coin": c, "criterion": "price_change"}
    assets = [make_asset(c, mark_px=100.0) for c in COINS]  # revenus à la normale
    ctx = make_ctx(*COINS, vol_recent=10.0, vol_baseline=10.0)

    alert_engine.evaluate_all(assets, ctx)

    assert len(spy.resolves) == 50
    assert spy.calls["resolve"] == 1


def test_le_cout_en_requetes_ne_depend_pas_du_nombre_de_coins(spy):
    """Doubler les coins ne doit pas doubler les requêtes."""
    petit = [make_asset(c, mark_px=120.0, open_interest=1500.0) for c in COINS[:10]]
    alert_engine.evaluate_all(petit, make_ctx(*COINS[:10]))
    cout_petit = dict(spy.calls)

    spy.calls.update({k: 0 for k in spy.calls})
    grand = [make_asset(c, mark_px=120.0, open_interest=1500.0) for c in COINS]
    alert_engine.evaluate_all(grand, make_ctx(*COINS))

    assert spy.calls == cout_petit
