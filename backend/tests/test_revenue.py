"""Revenus des protocoles : agrégation, rattachement aux tokens Hyperliquid, onglets."""
from __future__ import annotations

from app import revenue

CFG = {
    "protocols": [
        {"id": "1", "symbol": "UNI", "gecko_id": None},
        {"id": "2", "symbol": "UNI", "gecko_id": None},
        {"id": "3", "symbol": "LDO", "gecko_id": "lido-dao"},
        {"id": "4", "symbol": "NEAR", "gecko_id": "near"},
        {"id": "5", "symbol": "KNTQ", "gecko_id": "kinetiq"},
        {"id": "6", "symbol": "KNTQ", "gecko_id": "kntq-elsewhere"},
        {"id": "7", "symbol": "LDO", "gecko_id": "lido-clone"},
        {"id": "8", "symbol": "-", "gecko_id": None},
    ],
    "parentProtocols": [
        {"id": "parent#uniswap", "name": "Uniswap", "symbol": "UNI", "gecko_id": "uniswap"},
        {"id": "parent#hyperliquid", "name": "Hyperliquid", "symbol": "HYPE", "gecko_id": "hyperliquid"},
    ],
    "chainCoingeckoIds": {
        "Ethereum": {"geckoId": "ethereum", "symbol": "ETH"},
        "Arbitrum": {"geckoId": "arbitrum", "symbol": "ARB", "parent": {"chain": "Ethereum", "types": ["L2", "gas"]}},
        "Hyperliquid L1": {"geckoId": "hyperliquid", "symbol": "HYPE"},
        "Near": {"geckoId": "near", "symbol": "NEAR"},
    },
}


def entry(name, r30, *, cat="Dexs", parent=None, did=None, chain=False, chains=("Ethereum",), r60=0.0):
    return {
        "name": name, "displayName": name, "category": "Chain" if chain else cat, "parentProtocol": parent,
        "defillamaId": did, "protocolType": "chain" if chain else "protocol", "chains": list(chains),
        "total24h": r30 / 30, "total30d": r30, "total60dto30d": r60, "total1y": r30 * 12,
    }


REV = [
    entry("Uniswap V3", 6e6, parent="parent#uniswap", did="1", r60=5e6),
    entry("Uniswap V2", 2e6, parent="parent#uniswap", did="2", r60=1e6),
    entry("Hyperliquid Perps", 60e6, cat="Derivatives", parent="parent#hyperliquid", did="9"),
    entry("Hyperliquid L1", 1e6, chain=True),
    entry("Ethereum", 6e6, chain=True),
    entry("Arbitrum", 0.6e6, chain=True),
    entry("Lido", 3e6, cat="Liquid Staking", did="3"),
    entry("Lido clone", 9e6, cat="Liquid Staking", did="7"),
    entry("NEAR Bridge", 2e6, cat="Bridge", did="4"),
    entry("Near", 0.5e6, chain=True),
    entry("Kinetiq", 1e6, cat="Liquid Staking", did="5", chains=("Hyperliquid L1",)),
    entry("Other KNTQ", 5e6, cat="Dexs", did="6"),
    entry("Tether", 500e6, cat="Stablecoin Issuer", did="8"),
]

MARKETS = {
    "uniswap": {"market_cap": 4e9, "fully_diluted_valuation": 6e9, "current_price": 7,
                "price_change_percentage_7d_in_currency": -3.5, "price_change_percentage_30d_in_currency": 12.0},
    "hyperliquid": {"market_cap": 17e9, "fully_diluted_valuation": 70e9, "current_price": 50},
    "ethereum": {"market_cap": 250e9, "fully_diluted_valuation": 250e9, "current_price": 2000},
    "arbitrum": {"market_cap": 1e9, "fully_diluted_valuation": 1.6e9, "current_price": 0.2},
    "lido-dao": {"market_cap": 270e6, "fully_diluted_valuation": 320e6, "current_price": 0.3},
    "lido-clone": {"market_cap": 1e6, "fully_diluted_valuation": 2e6, "current_price": 0.01},
    "near": {"market_cap": 4.7e9, "fully_diluted_valuation": 4.7e9, "current_price": 3},
    "kinetiq": {"market_cap": 50e6, "fully_diluted_valuation": 200e6, "current_price": 0.5},
    "kntq-elsewhere": {"market_cap": 900e6, "fully_diluted_valuation": 900e6, "current_price": 1},
}

PERPS = {"UNI", "HYPE", "ETH", "ARB", "LDO", "NEAR"}
SPOT = {"KNTQ", "HYPE", "PURR"}


def rows():
    groups = revenue.build_groups(REV, CFG)
    return {r["symbol"]: r for r in revenue.assemble(revenue.candidates(groups, PERPS, SPOT), MARKETS, PERPS)}


def test_les_versions_d_un_protocole_sont_additionnees_sous_leur_parent():
    uni = rows()["UNI"]
    assert uni["name"] == "Uniswap" and uni["rev_30d"] == 8e6 and uni["rev_prev_30d"] == 6e6
    assert uni["tab"] == "dex" and uni["listed"] == "perp"


def test_protocole_et_chaine_du_meme_token_sont_cumules_et_le_produit_l_emporte():
    hype = rows()["HYPE"]
    assert hype["rev_30d"] == 61e6
    assert [s["name"] for s in hype["sources"]] == ["Hyperliquid", "Hyperliquid L1"]
    assert hype["tab"] == "derivatives"


def test_un_pont_ne_fait_pas_d_une_l1_une_infrastructure():
    assert rows()["NEAR"]["tab"] == "l1"


def test_l1_et_l2():
    r = rows()
    assert r["ETH"]["tab"] == "l1" and r["ARB"]["tab"] == "l2"


def test_symbole_partage_le_token_de_plus_grosse_capitalisation_l_emporte():
    """Un clone au même symbole, même plus rentable, n'usurpe pas LDO."""
    ldo = rows()["LDO"]
    assert ldo["gecko_id"] == "lido-dao" and ldo["rev_30d"] == 3e6


def test_spot_seul_exige_un_protocole_sur_hyperliquid():
    """KNTQ coté en spot : seul Kinetiq (sur Hyperliquid) est retenu, pas
    l'homonyme d'une autre chaîne pourtant plus capitalisé."""
    kntq = rows()["KNTQ"]
    assert kntq["gecko_id"] == "kinetiq" and kntq["listed"] == "spot"


def test_sans_token_ou_sans_cours_pas_de_ligne():
    r = rows()
    assert all(s not in r for s in ("-", "USDT", "PURR"))


def test_multiples_et_tri():
    ordered = [r["symbol"] for r in revenue.assemble(revenue.candidates(revenue.build_groups(REV, CFG), PERPS, SPOT), MARKETS, PERPS)]
    assert ordered[0] == "HYPE"
    uni = rows()["UNI"]
    assert uni["mcap"] == 4e9 and uni["fdv"] == 6e9 and uni["price"] == 7


HOLDERS = [
    entry("Uniswap V3", 5e6, parent="parent#uniswap", did="1"),
    entry("Hyperliquid Perps", 60e6, cat="Derivatives", parent="parent#hyperliquid", did="9"),
    entry("Hyperliquid L1", 1e6, chain=True),
    entry("Lido", 0.0, cat="Liquid Staking", did="3"),
]


def rows_with_holders():
    groups = revenue.build_groups(REV, CFG)
    holders = {g.key: g for g in revenue.build_groups(HOLDERS, CFG, keep_all=True)}
    return {r["symbol"]: r for r in revenue.assemble(revenue.candidates(groups, PERPS, SPOT), MARKETS, PERPS, holders)}


def test_revenus_aux_detenteurs_sommes_sur_les_memes_entites():
    r = rows_with_holders()
    assert r["HYPE"]["hold_30d"] == 61e6          # perps + L1
    assert r["UNI"]["hold_30d"] == 5e6            # V3 seulement : V2 ne reverse rien


def test_publie_a_zero_n_est_pas_inconnu():
    r = rows_with_holders()
    assert r["LDO"]["hold_30d"] == 0.0            # publié : rien n'est reversé
    assert r["ETH"]["hold_30d"] is None           # rien de publié : inconnu


def test_variations_de_prix_en_fractions():
    uni = rows()["UNI"]
    assert uni["px_chg_7d"] == -0.035 and uni["px_chg_30d"] == 0.12
    assert rows()["ETH"]["px_chg_30d"] is None


def test_symboles_hyperliquid():
    assert revenue.hl_symbol("kPEPE") == "PEPE"
    assert revenue.hl_symbol("kBONK") == "BONK"
    assert revenue.hl_symbol("KAITO") == "KAITO"
    assert revenue.hl_symbol("HYPE") == "HYPE"


def test_le_releve_force_exige_le_secret(monkeypatch):
    from fastapi.testclient import TestClient

    from app import config, db

    monkeypatch.setattr(db, "init_db", lambda: None)
    monkeypatch.setattr(config, "RUN_POLLER", False)
    monkeypatch.setattr(config, "CRON_SECRET", "s3cret")
    from app.main import app

    with TestClient(app) as c:
        assert c.post("/api/revenue/refresh").status_code == 401
        assert c.post("/api/revenue/refresh", headers={"Authorization": "Bearer faux"}).status_code == 401
