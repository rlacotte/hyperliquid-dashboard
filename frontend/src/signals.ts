/**
 * Lecture du track record des alertes (cf. backend/app/track_record.py).
 *
 * Le danger d'un track record est de faire dire aux chiffres plus qu'ils ne
 * disent. Ce module encode trois garde-fous :
 * - l'unité statistique est la GRAPPE (coin, jour) et non l'alerte : 85
 *   alertes d'un seul coin décrivent quelques épisodes, pas 85 observations
 *   indépendantes (constaté : un « z = 2,9 » sur un seul coin) ;
 * - pas de verdict sous 3 coins distincts ni sous un nombre minimal de grappes ;
 * - « significatif » suit un test binomial (z ≥ 2 contre 50 %) sur les grappes ;
 * - le verdict porte sur la performance RELATIVE au BTC, pour ne pas confondre
 *   le signal avec le mouvement général du marché.
 */
import type { Alert, Criterion } from "./types";

export type HorizonKey = "1h" | "4h" | "24h";

export interface HorizonStats {
  n: number;
  p_up?: number;
  mean?: number;
  median?: number;
  n_vs_btc?: number;
  mean_vs_btc?: number | null;
  p_beat_btc?: number | null;
  /** Épisodes indépendants : grappes (coin, jour). */
  n_clusters?: number;
  mean_vs_btc_clusters?: number | null;
  p_beat_btc_clusters?: number | null;
}

export interface TrackGroup {
  criterion: Criterion;
  sign: -1 | 0 | 1;
  alerts: number;
  coins: number;
  horizons: Record<HorizonKey, HorizonStats>;
}

export interface TrackRecord {
  groups: TrackGroup[];
  outcomes: number;
  horizons_h: number[];
  lookback_days: number;
}

/** Même règle que le backend (signal_sign) : sens de l'alerte. */
export function alertSign(a: Pick<Alert, "criterion" | "details" | "direction">): -1 | 0 | 1 {
  const d = (a.details ?? {}) as Record<string, unknown>;
  let v: unknown;
  if (a.criterion === "price_change" || a.criterion === "open_interest") v = d.delta_pct;
  else if (a.criterion === "funding_rate") v = d.funding;
  else if (a.criterion === "confluence") return a.direction === "bullish" ? 1 : a.direction === "bearish" ? -1 : 0;
  else return 0;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  if (!Number.isFinite(n) || n === 0) return 0;
  return n > 0 ? 1 : -1;
}

const LABELS: Record<string, string> = {
  "price_change|1": "Hausse brutale du prix",
  "price_change|-1": "Chute brutale du prix",
  "open_interest|1": "Afflux d'open interest",
  "open_interest|-1": "Fuite d'open interest",
  "funding_rate|1": "Funding extrême positif (longs paient)",
  "funding_rate|-1": "Funding extrême négatif (shorts paient)",
  "volume|0": "Pic de volume anormal",
  "confluence|1": "Confluence haussière",
  "confluence|-1": "Confluence baissière",
  "confluence|0": "Confluence neutre",
};

export const signalLabel = (criterion: string, sign: number): string => LABELS[`${criterion}|${sign}`] ?? `${criterion} (${sign})`;

export function findGroup(track: TrackRecord | null | undefined, criterion: string, sign: number): TrackGroup | undefined {
  return track?.groups.find((g) => g.criterion === criterion && g.sign === sign);
}

/** En dessous, aucun verdict : la variance d'un petit échantillon domine tout. */
export const MIN_SAMPLE = 30;
/** Épisodes indépendants minimum (grappes coin × jour). */
export const MIN_CLUSTERS = 20;
/** Un résultat porté par un ou deux coins n'est pas généralisable. */
export const MIN_COINS = 3;

/** z d'un test binomial d'une proportion contre 50 %. */
export function binomialZ(p: number, n: number): number {
  return n > 0 ? (p - 0.5) / Math.sqrt(0.25 / n) : 0;
}

export interface Verdict {
  tone: "positive" | "negative" | "neutral" | "unknown";
  text: string;
  significant: boolean;
}

/**
 * Le coin a-t-il fait mieux ou moins bien que le BTC après ce type d'alerte ?
 *
 * Volontairement sans thèse de trading : on dit ce qui s'est passé (« a
 * sous-performé le BTC »), pas ce qu'il faudrait faire. Une même mesure se lit
 * différemment selon la stratégie (suivre ou prendre à contre-pied).
 */
export function verdict(h: HorizonStats | undefined, coins: number): Verdict {
  const n = h?.n_clusters ?? 0;
  const p = h?.p_beat_btc_clusters;
  const mean = h?.mean_vs_btc_clusters;
  if (!h || !h.n_vs_btc || !n || p === null || p === undefined || mean === null || mean === undefined) {
    return { tone: "unknown", text: "Pas encore de mesure", significant: false };
  }
  if (coins < MIN_COINS) {
    return { tone: "unknown", text: `Concentré sur ${coins} coin${coins > 1 ? "s" : ""} : non généralisable`, significant: false };
  }
  if (n < MIN_CLUSTERS) {
    return { tone: "unknown", text: `Trop peu d'épisodes indépendants (${n})`, significant: false };
  }
  const z = binomialZ(p, n);
  const significant = Math.abs(z) >= 2;
  if (!significant) return { tone: "neutral", text: "Pas d'écart mesurable avec le marché", significant };
  const pct = `${mean >= 0 ? "+" : ""}${(mean * 100).toFixed(2)} %`;
  return p > 0.5
    ? { tone: "positive", text: `Surperforme le BTC (${pct} par épisode)`, significant }
    : { tone: "negative", text: `Sous-performe le BTC (${pct} par épisode)`, significant };
}
