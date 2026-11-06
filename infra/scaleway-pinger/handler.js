/**
 * Déclencheur de collecte — Scaleway Serverless Function (runtime node22).
 *
 * Pourquoi ici et plus sur GitHub Actions : sur 1 000 déclenchements mesurés
 * (juillet → septembre 2026), le cron GitHub demandé toutes les 5 min a tiré
 * avec un écart médian de 53 min et jusqu'à 12,5 h — 6 % de couverture
 * effective. Les critères d'alerte, qui comparent l'état courant à celui
 * d'il y a 10 à 120 min, étaient donc aveugles la plupart du temps.
 *
 * Fonctionnement : un déclencheur CRON Scaleway appelle cette fonction chaque
 * minute ; elle lance UN cycle de collecte.
 *
 * Pourquoi une minute et pas 30 s : chaque cycle s'exécute sur Vercel, dont le
 * plan Hobby plafonne DUREMENT le CPU actif à 4 h/mois (au-delà, le site cesse
 * de servir). Mesuré : ~45 ms de CPU par cycle en local ; avec un facteur ×3
 * pour les CPU Vercel, 2 cycles/min frôlaient le plafond. À 1 cycle/min on
 * garde ~50 % de marge, sans rien perdre pour des critères d'alerte qui
 * travaillent sur des fenêtres de 10 à 120 min. Pour revenir à 30 s : passer
 * CYCLES à 2 (et idéalement Vercel en Pro).
 *
 * Variables (définies sur la fonction, pas dans ce fichier) :
 *   DASHBOARD_URL : https://<projet>.vercel.app
 *   CRON_SECRET   : variable SECRÈTE, identique à celle de Vercel
 *
 * Coût : ~43 200 appels et ~60 000 Go-s par mois à 128 Mo, largement dans le
 * palier gratuit Scaleway (1 M de requêtes, 400 000 Go-s).
 *
 * Redéploiement : voir infra/scaleway-pinger/README.md.
 */

const CYCLES = 1;
const SPACING_MS = 30_000;
// La fonction Vercel plafonne à 60 s : inutile d'attendre au-delà.
const REQUEST_TIMEOUT_MS = 58_000;

export { handle };

async function handle() {
  const url = `${process.env.DASHBOARD_URL}/api/cron/poll`;
  const results = [];
  // Identifiant d'invocation, journalisé côté serveur : permet de distinguer
  // les 2 cycles normaux d'une invocation d'éventuelles invocations en double.
  const invocation = Math.random().toString(36).slice(2, 8);

  for (let i = 0; i < CYCLES; i++) {
    const started = Date.now();
    try {
      const resp = await fetch(url, {
        headers: {
          Authorization: `Bearer ${process.env.CRON_SECRET}`,
          "X-Pinger": `scaleway:${invocation}:${i}`,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      results.push({ status: resp.status, ms: Date.now() - started });
    } catch (err) {
      // Un cycle raté ne doit pas empêcher le suivant.
      results.push({ status: String(err?.name ?? err), ms: Date.now() - started });
    }
    if (i < CYCLES - 1) {
      // Cadence mesurée de début à début, pas un sleep fixe après la requête.
      const wait = SPACING_MS - (Date.now() - started);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
  }

  const ok = results.every((r) => r.status === 200);
  console.log(JSON.stringify({ ok, results }));
  return { statusCode: ok ? 200 : 502, body: JSON.stringify({ ok, results }) };
}
