"""Configuration: seuils d'alerte, intervalles, URLs.

Les valeurs peuvent être surchargées par des variables d'environnement (fichier .env).
Toutes les valeurs sont des constantes — ajustez-les pour tuner le comportement.
"""
from __future__ import annotations

import os

from dotenv import load_dotenv

# Sur Vercel (VERCEL=1), la configuration vient UNIQUEMENT des variables du
# projet. Incident constaté : backend/.env, le fichier de développement local,
# partait avec chaque déploiement et était chargé ici — son RUN_POLLER=1
# lançait une boucle de collecte dans chaque instance, en plus du cron et sans
# son verrou anti-doublon : deux cycles par minute, CPU doublé, et chaque
# mouvement de wallet notifié deux fois sur Telegram.
ON_VERCEL = bool(os.getenv("VERCEL"))
if not ON_VERCEL:
    load_dotenv()

# --- API Hyperliquid ---------------------------------------------------------
HYPERLIQUID_API_URL = os.getenv(
    "HYPERLIQUID_API_URL", "https://api.hyperliquid.xyz"
)
HTTP_TIMEOUT_SEC = float(os.getenv("HTTP_TIMEOUT_SEC", "15"))

# --- Polling -----------------------------------------------------------------
# Cadence de collecte des données marché (metaAndAssetCtxs + allMids)
POLL_INTERVAL_SEC = float(os.getenv("POLL_INTERVAL_SEC", "60"))

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
# nuisible en serverless où c'est le cron qui déclenche la collecte : une
# instance gelée entre deux requêtes relance sa boucle à chaque réveil, en
# même temps que le cycle du cron. Toujours coupé sur Vercel.
RUN_POLLER = os.getenv("RUN_POLLER", "0") == "1" and not ON_VERCEL

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

# --- Confluence (matrice de régimes Prix x OI) -------------------------------
# La direction et la fiabilité viennent du régime (cf. confluence._REGIMES),
# pas de poids par critère : les anciens CONFLUENCE_WEIGHT_* ont disparu avec
# la v1 (somme pondérée).
# Nb minimum de critères actifs pour déclencher une alerte de confluence
CONFLUENCE_MIN_CRITERIA = int(os.getenv("CONFLUENCE_MIN_CRITERIA", "3"))
# Seuils d'amplitude du score agrégé (en absolu) pour la sévérité
CONFLUENCE_SCORE_WARN = float(os.getenv("CONFLUENCE_SCORE_WARN", "4.0"))
CONFLUENCE_SCORE_CRIT = float(os.getenv("CONFLUENCE_SCORE_CRIT", "7.0"))

# --- Anti-bruit ----------------------------------------------------------------
# Mesuré sur les alertes réelles : une alerte « volume » vivait 2 min en médiane,
# et un quart se redéclenchait dans les 10 min suivant sa résolution (24 % pour
# le prix) — oscillation autour du seuil, et autant de notifications.
# Hystérésis : déclenchement au seuil, résolution seulement sous ce ratio du seuil.
ALERT_RESOLVE_RATIO = float(os.getenv("ALERT_RESOLVE_RATIO", "0.7"))
# Refroidissement : après résolution (ou acquittement), pas de nouvelle alerte
# du même type sur le même coin pendant ce délai — sauf passage en critique.
ALERT_COOLDOWN_SEC = int(os.getenv("ALERT_COOLDOWN_SEC", "1800"))

# --- Marchés HIP-3 ---------------------------------------------------------------
# Les DEX HIP-3 (actions, indices, matières premières, devises) entrent dans la
# collecte et le moteur d'alertes. Seuil d'activité : sous ce volume quotidien
# ET cet open interest, un marché est ignoré — carnet trop mince pour qu'une
# alerte ait un sens, et chaque marché suivi coûte du CPU Vercel (plafond Hobby).
HIP3_ENABLED = os.getenv("HIP3_ENABLED", "1") == "1"
HIP3_MIN_ACTIVITY_USD = float(os.getenv("HIP3_MIN_ACTIVITY_USD", "250000"))

# --- Arbitrage de funding (cf. funding_arb.py) ----------------------------------------
# Écart annualisé à partir duquel on SUIT un écart dans le temps.
ARB_TRACK_MIN_APR = float(os.getenv("ARB_TRACK_MIN_APR", "0.15"))
# Alerte : écart au moins égal à ce seuil ET continu depuis ARB_MIN_DURATION_SEC.
ARB_ALERT_APR = float(os.getenv("ARB_ALERT_APR", "0.30"))
ARB_CRIT_APR = float(os.getenv("ARB_CRIT_APR", "0.60"))
ARB_MIN_DURATION_SEC = int(os.getenv("ARB_MIN_DURATION_SEC", str(2 * 3600)))
# Sans profondeur, l'écart n'est pas exploitable : OI Hyperliquid minimal.
ARB_MIN_OI_USD = float(os.getenv("ARB_MIN_OI_USD", "1000000"))
ARB_REFRESH_SEC = int(os.getenv("ARB_REFRESH_SEC", "300"))

# --- Notifications sortantes --------------------------------------------------
# Les alertes s'affichent dans l'UI, mais personne ne regarde un dashboard à
# 3h du matin : les nouvelles alertes sont aussi poussées vers Telegram et/ou
# Discord. Chaque canal est actif dès que ses variables sont renseignées ;
# sans configuration, aucune notification (no-op silencieux).
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "")
DISCORD_WEBHOOK_URL = os.getenv("DISCORD_WEBHOOK_URL", "")
# Sévérité minimale notifiée : "info" | "warning" | "critical".
# Défaut critical : sur ~230 perps, les warnings sont trop fréquents pour
# mériter une interruption.
NOTIFY_MIN_SEVERITY = os.getenv("NOTIFY_MIN_SEVERITY", "critical")

# --- Bot Telegram (abonnements individuels) -----------------------------------
# Le même TELEGRAM_BOT_TOKEN sert au bot : chaque visiteur relie sa liste de
# wallets suivis à sa propre conversation, sans compte. Sans token, le bot est
# simplement absent de l'interface.
PUBLIC_URL = os.getenv("PUBLIC_URL", "https://hyperliquid-dashboard-mocha.vercel.app").rstrip("/")
# Wallets lus par cycle (une requête userFillsByTime, poids ~20, chacun) : au-delà,
# la lecture tourne et chaque wallet est vu moins souvent qu'une fois par minute.
TG_MAX_WALLETS_PER_CYCLE = int(os.getenv("TG_MAX_WALLETS_PER_CYCLE", "25"))
TG_MAX_WALLETS_PER_SUB = int(os.getenv("TG_MAX_WALLETS_PER_SUB", "25"))
# Abonnements non reliés créés sur 24 h : borne contre le remplissage de la base.
TG_MAX_PENDING_SUBS = int(os.getenv("TG_MAX_PENDING_SUBS", "500"))

# --- Frontend ----------------------------------------------------------------
CORS_ORIGINS = os.getenv("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",")

# --- Métriques globales (sources externes) -----------------------------------
# CoinGecko : clé Demo optionnelle (https://www.coingecko.com/api/management).
# Sans clé, on utilise l'API publique (rate limit plus bas mais suffisant).
COINGECKO_API_KEY = os.getenv("COINGECKO_API_KEY", "")
COINGECKO_BASE_URL = os.getenv("COINGECKO_BASE_URL", "https://api.coingecko.com/api/v3")
FNG_BASE_URL = os.getenv("FNG_BASE_URL", "https://api.alternative.me/fng")
# Durées de cache : la F&G est quotidienne, CoinGecko rafraîchi toutes les minutes.
FNG_CACHE_TTL_SEC = int(os.getenv("FNG_CACHE_TTL_SEC", "3600"))       # 1h
COINGECKO_CACHE_TTL_SEC = int(os.getenv("COINGECKO_CACHE_TTL_SEC", "60"))  # 1 min
