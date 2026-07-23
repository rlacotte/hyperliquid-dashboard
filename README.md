# Hyperliquid Dashboard

Dashboard crypto avec **alertes d'investissement** basé sur l'[API publique Hyperliquid](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api).

Aucune clé API ni authentification requise : l'endpoint `/info` d'Hyperliquid est 100 % public et en lecture seule.

## Fonctionnalités

- **Tableau de marché temps réel** : tous les perps Hyperliquid avec prix, % change 24h, funding rate, open interest, volume 24h (colonnes triables).
- **Graphiques** : bougies OHLCV (TradingView lightweight-charts) + historique du funding rate par actif.
- **Alertes automatiques** sur 4 critères configurables :
  1. **Funding rate élevé** — sentiment extrême du marché
  2. **Pic d'Open Interest** — entrée/sortie brutale de capitaux
  3. **Volume anormal** — pic d'activité (seuil absolu ou multiple de la moyenne récente)
  4. **Variation de prix** — mouvement significatif sur une fenêtre donnée
- Panneau d'alertes live avec badges de sévérité (info / warning / critical) et acquittement.

## Stack

- **Backend** : Python 3.11 · FastAPI · httpx · PostgreSQL (psycopg 3)
- **Frontend** : React + Vite + TypeScript · Tailwind CSS · lightweight-charts
- **Hébergement** : Vercel (front statique + API en fonction serverless)

## Démarrage rapide

### Prérequis
- Python 3.11+
- Node.js 18+
- Une base PostgreSQL accessible (`DATABASE_URL`)

### 1. Backend (`http://localhost:8000`)
```bash
cd backend
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
export DATABASE_URL="postgresql://user:pass@host:port/dbname?sslmode=require"
RUN_POLLER=1 uvicorn app.main:app --reload
```
API disponible sur `http://localhost:8000`, docs Swagger sur `http://localhost:8000/docs`.

`RUN_POLLER=1` relance la boucle de collecte dans le processus (confort du dev
local). En production c'est un cron qui appelle `/api/cron/poll` — sans ce flag,
le backend sert l'API mais ne collecte rien.

### 2. Frontend (`http://localhost:5173`)
```bash
cd frontend
npm install
npm run dev
```
Ouvrir `http://localhost:5173`.

## Configuration des seuils d'alerte

Tous les seuils sont dans [`backend/app/config.py`](backend/app/config.py) et peuvent être surchargés via des variables d'environnement (fichier `backend/.env`) :

| Variable | Défaut | Description |
|---|---|---|
| `DATABASE_URL` | — | URL PostgreSQL (**requis**). `POSTGRES_URL` accepté en repli |
| `CRON_SECRET` | — | Protège `/api/cron/poll`. Vide = route ouverte |
| `RUN_POLLER` | `0` | `1` = boucle de collecte in-process (dev local) |
| `MAINTENANCE_INTERVAL_SEC` | `300` | Intervalle mini entre 2 passes downsample + purge |
| `POLL_INTERVAL_SEC` | `30` | Cadence de collecte des données |
| `FUNDING_THRESHOLD_WARN` / `_CRIT` | `0.0005` / `0.001` | Seuils funding (0.05% / 0.1%) |
| `OI_LOOKBACK_MIN` | `60` | Fenêtre de comparaison Open Interest |
| `OI_PCT_THRESHOLD_WARN` / `_CRIT` | `0.10` / `0.20` | Variation OI (10% / 20%) |
| `VOLUME_RECENT_MIN` / `VOLUME_BASELINE_MIN` | `10` / `120` | Fenêtres du taux de volume (détection / référence) |
| `VOLUME_SPIKE_MULT_WARN` / `_CRIT` | `3.0` / `6.0` | Multiple du taux de volume vs baseline |
| `VOLUME_MIN_RATE_USDPS` | `5000` | Plancher de taux de volume ($/s, filtre les petits coins) |
| `PRICE_LOOKBACK_MIN` | `60` | Fenêtre variation de prix |
| `PRICE_PCT_THRESHOLD_WARN` / `_CRIT` | `0.05` / `0.10` | Variation prix (5% / 10%) |
| `CONFLUENCE_SCORE_WARN` / `_CRIT` | `4.0` / `7.0` | Amplitude du score de confluence par sévérité |

L'anti-spam des alertes ne se règle plus par fenêtre temporelle : il est
structurel (au plus une alerte active par couple coin/critère, imposé par un
index unique en base).

## Endpoints API

| Méthode | Route | Description |
|---|---|---|
| `GET` | `/api/health` | Statut + nb d'actifs suivis |
| `GET` | `/api/markets` | Snapshot marché de tous les perps |
| `GET` | `/api/markets/{coin}/candles?interval=1h&hours=24` | OHLCV historique |
| `GET` | `/api/markets/{coin}/funding?hours=72` | Historique funding |
| `GET` | `/api/alerts?only_active=true&limit=100` | Liste des alertes |
| `PATCH` | `/api/alerts/{id}/ack` | Acquitter une alerte |
| `GET` | `/api/cron/poll` | Exécute un cycle de collecte (appelé par le cron) |

## Déploiement Vercel

Le front est build en statique, l'API FastAPI tourne en fonction serverless
(`api/index.py` expose l'app ASGI), et les deux sont servis sur la même origine
— d'où une base d'API vide côté front.

```bash
vercel env add DATABASE_URL production   # URL Postgres poolée
vercel env add CRON_SECRET production    # secret partagé avec le cron
vercel --prod
```

### Collecte périodique

Les critères d'alerte comparent l'état courant à l'historique des 10 à 120
dernières minutes : **sans collecte régulière, aucune alerte ne se déclenche.**

Le plan **Hobby** ne déclenche les crons Vercel qu'une fois par jour, ce qui est
insuffisant. Le dépôt fournit donc [`.github/workflows/poll.yml`](.github/workflows/poll.yml),
qui appelle `/api/cron/poll` toutes les 30 s. Il attend deux secrets de dépôt :
`DASHBOARD_URL` et `CRON_SECRET`.

Sur un plan **Pro**, supprimer ce workflow et passer le `schedule` de
[`vercel.json`](vercel.json) à `* * * * *` : le cron natif suffit.

## Architecture

```
hyperliquid-dashboard/
├── api/
│   └── index.py                 # Entrée serverless Vercel (expose l'app ASGI)
├── backend/
│   ├── app/
│   │   ├── main.py              # Application FastAPI
│   │   ├── poller.py            # Cycle de collecte (1 cycle = 1 invocation)
│   │   ├── config.py            # Seuils configurables
│   │   ├── hyperliquid_client.py# Client API Hyperliquid
│   │   ├── db.py                # Postgres (snapshots + alertes + état partagé)
│   │   ├── cache.py             # Dernier snapshot marché
│   │   ├── alert_engine.py      # 5 critères d'alerte
│   │   ├── confluence.py        # Score multi-critères directionnel
│   │   ├── models.py            # Modèles Pydantic
│   │   └── routes/              # markets.py, alerts.py, cron.py
│   └── requirements.txt
├── frontend/
│   └── src/                     # React + Vite + Tailwind
├── requirements.txt             # Dépendances de la fonction serverless
└── vercel.json
```

Chaque cycle collecte `metaAndAssetCtxs` (tous les perps en un appel), persiste
un snapshot Postgres, et évalue les critères. Les snapshots historiques
permettent de détecter les variations temporelles (OI, prix) que l'API ne
fournit qu'en valeur instantanée.

Deux contraintes du serverless façonnent le code :

- **Rien ne survit entre deux invocations.** Le dernier snapshot marché et les
  scores de confluence transitent par une table `kv` au lieu de variables
  globales, sinon la requête qui sert `/api/markets` ne verrait jamais ce que le
  cron a collecté.
- **Chaque requête SQL part sur le réseau.** Un cycle évalue ~200 coins × 5
  critères ; interroger la base par coin représenterait ~1500 allers-retours. Un
  `HistoryContext` précharge tout l'historique en 3-4 requêtes, et les écritures
  d'alertes sont accumulées puis appliquées en 3 requêtes.
