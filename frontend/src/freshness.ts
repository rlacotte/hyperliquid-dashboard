/**
 * Qualification de la fraîcheur de la donnée marché.
 *
 * La collecte tourne toutes les 30 s, déclenchée par un cron *externe* à Vercel.
 * S'il meurt, l'API continue de servir le dernier snapshot en base : les requêtes
 * réussissent, seule la donnée vieillit. Un indicateur basé sur l'état de la
 * requête afficherait donc « Live » sur des prix figés — le mode de panne le plus
 * probable de l'architecture, et celui qui est passé inaperçu six semaines durant.
 *
 * Deux seuils, pour signaler sans crier au loup :
 * - LAGGING : un cycle manqué. Le cron GitHub est planifié toutes les 5 min avec
 *   une gigue de plusieurs minutes possible ; un retard court est normal. Signal
 *   discret (badge en ambre), pas de bandeau.
 * - DOWN : plusieurs runs manqués d'affilée. Là, la collecte est réellement
 *   arrêtée. Bandeau pleine largeur, impossible à rater.
 */
export const LAGGING_AFTER_MS = 120_000; // 2 min — 4x l'intervalle de collecte
export const DOWN_AFTER_MS = 600_000; // 10 min — au-delà de la gigue de planification

export type Freshness = "live" | "lagging" | "down" | "error" | "pending";

/**
 * `error` prime quand il y a déjà une donnée : la requête échoue, donc plus rien
 * ne rafraîchit ce qui est affiché. Sans donnée du tout, on distingue l'erreur
 * initiale de la simple connexion en cours.
 */
export function classifyFreshness(
  ts: number | undefined,
  error: string | null,
  now: number = Date.now()
): Freshness {
  if (!ts) return error ? "error" : "pending";
  if (error) return "error";
  const age = now - ts;
  if (age > DOWN_AFTER_MS) return "down";
  if (age > LAGGING_AFTER_MS) return "lagging";
  return "live";
}

export function fmtAge(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "moins d'une minute";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h`;
  return `${Math.floor(h / 24)} j`;
}
