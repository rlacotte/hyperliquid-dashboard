/**
 * Revenus des protocoles cotés sur Hyperliquid et multiples de valorisation.
 *
 * Les revenus (DefiLlama) et la capitalisation (CoinGecko) sont relevés côté
 * serveur toutes les 3 h. Entre deux relevés, le prix bouge : MC et FDV sont
 * donc réajustées au prix en direct quand le token est coté en perp (offre
 * inchangée, seul le prix varie), pour que les multiples restent à jour.
 */

export type RevenueTab = "l1" | "l2" | "dex" | "derivatives" | "lending" | "staking" | "stable" | "launchpad" | "infra" | "other";

export interface RevenueSource {
  name: string;
  kind: "chain" | "protocol";
  category: string | null;
  rev_30d: number;
}

export interface RevenueRow {
  symbol: string;
  name: string;
  gecko_id: string;
  tab: RevenueTab;
  category: string | null;
  listed: "perp" | "spot";
  rev_24h: number;
  rev_30d: number;
  rev_prev_30d: number;
  rev_1y: number;
  mcap: number | null;
  fdv: number | null;
  /** Prix CoinGecko au moment du relevé, référence de l'ajustement en direct. */
  price: number | null;
  sources: RevenueSource[];
}

export interface RevenueResponse {
  ts: number;
  rows: RevenueRow[];
}

export const TAB_LABELS: Record<RevenueTab, string> = {
  l1: "L1",
  l2: "L2",
  dex: "DEX",
  derivatives: "Dérivés",
  lending: "Lending",
  staking: "Staking",
  stable: "Stablecoins & rendement",
  launchpad: "Launchpads & apps",
  infra: "Infra & oracles",
  other: "Autres",
};

export const TAB_ORDER: RevenueTab[] = ["l1", "l2", "dex", "derivatives", "lending", "staking", "stable", "launchpad", "infra", "other"];

/** Base des multiples : 30 derniers jours annualisés (réactif) ou 12 derniers mois (lissé). */
export type Basis = "30d" | "1y";

export function annualRevenue(r: RevenueRow, basis: Basis): number {
  return basis === "30d" ? (r.rev_30d * 365) / 30 : r.rev_1y;
}

/** MC et FDV ramenées au prix en direct, si on en a un. */
export function liveValuation(r: RevenueRow, livePx: number | undefined): { mcap: number | null; fdv: number | null } {
  const k = livePx !== undefined && livePx > 0 && r.price ? livePx / r.price : 1;
  // Garde-fou : un écart de plus de 50 % trahit un prix d'une autre unité
  // (token re-dénominé, perp coté par 1 000) plutôt qu'un vrai mouvement.
  const ratio = k > 0.5 && k < 1.5 ? k : 1;
  return { mcap: r.mcap === null ? null : r.mcap * ratio, fdv: r.fdv === null ? null : r.fdv * ratio };
}

/** Multiple valorisation / revenus annuels ; null si l'un manque ou si le revenu est nul. */
export function multiple(valuation: number | null, annual: number): number | null {
  if (valuation === null || !(annual > 0)) return null;
  return valuation / annual;
}

/** Variation des revenus : 30 derniers jours contre les 30 précédents. */
export function revenueTrend(r: RevenueRow): number | null {
  return r.rev_prev_30d > 0 ? r.rev_30d / r.rev_prev_30d - 1 : null;
}

export function fmtMultiple(m: number | null): string {
  if (m === null) return "—";
  // Au-delà, le revenu est anecdotique : le chiffre exact n'a plus de sens.
  if (m >= 10_000) return "> 10 000×";
  if (m >= 1000) return `${Math.round(m).toLocaleString("fr-FR")}×`;
  if (m >= 100) return `${Math.round(m)}×`;
  return `${m.toFixed(1)}×`;
}

/** Couleur d'un multiple : bas = bon marché au regard des revenus. */
export function multipleTone(m: number | null): string {
  if (m === null) return "text-gray-600";
  if (m < 10) return "text-green-400";
  if (m < 30) return "text-gray-200";
  if (m < 100) return "text-amber-300";
  return "text-red-400";
}

/** Médiane, pour situer un token dans sa catégorie. */
export function median(values: number[]): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}
