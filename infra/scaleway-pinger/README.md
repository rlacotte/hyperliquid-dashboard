# Déclencheur de collecte (Scaleway)

Une Serverless Function Scaleway, appelée chaque minute par un CRON, lance un
cycle de collecte sur `GET /api/cron/poll`. Elle remplace le cron GitHub Actions,
mesuré à 6 % de couverture effective (cf. `.github/workflows/poll.yml`).

## Ressources (région fr-par)

| Ressource | Nom |
|---|---|
| Namespace | `hyperliquid-dashboard` |
| Fonction | `collect-pinger` — node22, 128 Mo, privée, timeout 130 s |
| CRON | `collect-every-minute` — `* * * * *` (UTC) |

Variables de la fonction : `DASHBOARD_URL` (en clair) et `CRON_SECRET`
(**variable secrète**, identique à celle de Vercel).

## Redéployer le code

```bash
zip -j /tmp/pinger.zip infra/scaleway-pinger/handler.js
scw function deploy namespace-id=<id du namespace> name=collect-pinger runtime=node22 zip-file=/tmp/pinger.zip region=fr-par
```

## Changer le secret

```bash
scw function function update <id fonction> secret-environment-variables.0.key=CRON_SECRET secret-environment-variables.0.value=<nouveau secret> region=fr-par
```

puis redéployer (ci-dessus), et mettre à jour la même valeur sur Vercel.

## Vérifier qu'il tourne

Les logs Vercel affichent une ligne `poll source=scaleway:<invocation>:0` par
minute ; une ligne `poll ignoré (doublon)` signale un appel en double écarté par
la garde serveur (sans coût de cycle). Côté dashboard, la pastille « Signaux »
passe en ambre après 2 min sans cycle, et un bandeau s'affiche après 10 min.

## Coût

~43 200 invocations et ~60 000 Go-s par mois : dans le palier gratuit Scaleway
(1 M de requêtes, 400 000 Go-s par compte et par mois).
