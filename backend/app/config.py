"""Configuration: seuils d'alerte, intervalles, URLs.

Les valeurs peuvent être surchargées par des variables d'environnement (fichier .env).
Toutes les valeurs sont des constantes — ajustez-les pour tuner le comportement.
"""
from __future__ import annotations

import os

from dotenv import load_dotenv

load_dotenv()

# --- API Hyperliquid ---------------------------------------------------------
HYPERLIQUID_API_URL = os.getenv(
    "HYPERLIQUID_API_URL", "https://api.hyperliquid.xyz"
)
HTTP_TIMEOUT_SEC = float(os.getenv("HTTP_TIMEOUT_SEC", "15"))

# --- Polling -----------------------------------------------------------------
# Cadence de collecte des données marché (metaAndAssetCtxs + allMids)
POLL_INTERVAL_SEC = float(os.getenv("POLL_INTERVAL_SEC", "30"))

# --- Base de données ---------------------------------------------------------
# Postgres. En local comme sur Vercel, la même variable pointe la base.
# Vercel Postgres injecte POSTGRES_URL ; Neon/Supabase donnent DATABASE_URL.
# Utiliser impérativement l'URL *poolée* en serverless : chaque invocation ouvre
# sa propre connexion, et une base non poolée sature vite son max_connections.
DATABASE_URL = os.getenv("DATABASE_URL") or os.getenv("POSTGRES_URL") or ""

# --- Cron de collecte --------------------------------------------------------
# Vercel Cron envoie `Authorization: Bearer $CRON_SECRET` quand la variable est
# définie. Sans secret, la route de collecte est ouverte — à ne pas laisser
# ainsi en production (n'importe qui pourrait déclencher des cycles).
CRON_SECRET = os.getenv("CRON_SECRET", "")

# Poller in-process : utile en dev local (uvicorn --reload), inutile et
# impossible en serverless où c'est le cron qui déclenche la collecte.
RUN_POLLER = os.getenv("RUN_POLLER", "0") == "1"

# Rétention des snapshots de marché (secondes)
SNAPSHOT_RETENTION_SEC = int(os.getenv("SNAPSHOT_RETENTION_SEC", str(7 * 24 * 3600)))

# --- Downsampling ------------------------------------------------------------
# Stratégie de conservation de la résolution des snapshots :
#   - récents (< DOWNSAMPLE_FULL_RES_SEC) : on garde tout (résolution 30s pour les alertes)
#   - plus anciens : on garde 1 point par DOWNSAMPLE_BUCKET_SEC (pour les graphes historiques)
# Le lookback le plus long pour les alertes est VOLUME_BASELINE_MIN (120 min),
# donc 3h de full-res couvre largement.
DOWNSAMPLE_FULL_RES_SEC = int(os.getenv("DOWNSAMPLE_FULL_RES_SEC", str(3 * 3600)))   # 3h
DOWNSAMPLE_BUCKET_SEC = int(os.getenv("DOWNSAMPLE_BUCKET_SEC", str(5 * 60)))          # 5 min
# Intervalle minimum entre deux passes de maintenance (downsample + purge).
# En serverless il n'y a pas de compteur de cycles qui survit d'une invocation à
# l'autre : on se base sur l'horodatage de la dernière passe, stocké en base.
MAINTENANCE_INTERVAL_SEC = int(os.getenv("MAINTENANCE_INTERVAL_SEC", "300"))  # 5 min

# --- Critères d'alerte -------------------------------------------------------
# Funding rate : valeur absolue (fraction décimale). 0.0005 = 0.05%
FUNDING_THRESHOLD_WARN = float(os.getenv("FUNDING_THRESHOLD_WARN", "0.0005"))
FUNDING_THRESHOLD_CRIT = float(os.getenv("FUNDING_THRESHOLD_CRIT", "0.001"))

# Open Interest : variation en % sur la fenêtre de lookback
OI_LOOKBACK_MIN = int(os.getenv("OI_LOOKBACK_MIN", "60"))
OI_PCT_THRESHOLD_WARN = float(os.getenv("OI_PCT_THRESHOLD_WARN", "0.10"))  # 10%
OI_PCT_THRESHOLD_CRIT = float(os.getenv("OI_PCT_THRESHOLD_CRIT", "0.20"))   # 20%

# Volume anormal : pic du TAUX de volume (USD/sec de volume neuf) vs baseline
# On compare le taux sur une fenêtre courte (recent) au taux sur une fenêtre
# longue (baseline). Évite l'alerte permanente sur BTC/ETH qui ont un fort
# volume cumulé 24h en permanence.
VOLUME_RECENT_MIN = int(os.getenv("VOLUME_RECENT_MIN", "10"))    # fenêtre courte (détection)
VOLUME_BASELINE_MIN = int(os.getenv("VOLUME_BASELINE_MIN", "120"))  # fenêtre longue (référence)
VOLUME_SPIKE_MULT_WARN = float(os.getenv("VOLUME_SPIKE_MULT_WARN", "3.0"))
VOLUME_SPIKE_MULT_CRIT = float(os.getenv("VOLUME_SPIKE_MULT_CRIT", "6.0"))
# Volume absolu minimum pour ignorer le bruit des petits coins (USD/sec)
VOLUME_MIN_RATE_USDPS = float(os.getenv("VOLUME_MIN_RATE_USDPS", "5000"))  # 5k USD/sec

# Variation de prix : % de variation sur la fenêtre
PRICE_LOOKBACK_MIN = int(os.getenv("PRICE_LOOKBACK_MIN", "60"))
PRICE_PCT_THRESHOLD_WARN = float(os.getenv("PRICE_PCT_THRESHOLD_WARN", "0.05"))  # 5%
PRICE_PCT_THRESHOLD_CRIT = float(os.getenv("PRICE_PCT_THRESHOLD_CRIT", "0.10"))   # 10%

# --- Confluence (score multi-critères directionnel) -------------------------
# Poids de chaque critère dans le score agrégé ∈ [-10, +10].
# Le poids est multiplié par le score signé ∈ [-1, +1] du critère.
CONFLUENCE_WEIGHT_PRICE = float(os.getenv("CONFLUENCE_WEIGHT_PRICE", "3.0"))
CONFLUENCE_WEIGHT_VOLUME = float(os.getenv("CONFLUENCE_WEIGHT_VOLUME", "2.0"))
CONFLUENCE_WEIGHT_OI = float(os.getenv("CONFLUENCE_WEIGHT_OI", "3.0"))
CONFLUENCE_WEIGHT_FUNDING = float(os.getenv("CONFLUENCE_WEIGHT_FUNDING", "2.0"))
# Nb minimum de critères actifs pour déclencher une alerte de confluence
CONFLUENCE_MIN_CRITERIA = int(os.getenv("CONFLUENCE_MIN_CRITERIA", "3"))
# Seuils d'amplitude du score agrégé (en absolu) pour la sévérité
CONFLUENCE_SCORE_WARN = float(os.getenv("CONFLUENCE_SCORE_WARN", "4.0"))
CONFLUENCE_SCORE_CRIT = float(os.getenv("CONFLUENCE_SCORE_CRIT", "7.0"))

# Déduplication : pas de nouvelle alerte pour (coin, criterion) tant qu'une
# alerte récente existe dans cette fenêtre (secondes)
ALERT_DEDUP_WINDOW_SEC = int(os.getenv("ALERT_DEDUP_WINDOW_SEC", "1800"))  # 30 min

# --- Frontend ----------------------------------------------------------------
CORS_ORIGINS = os.getenv("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",")
