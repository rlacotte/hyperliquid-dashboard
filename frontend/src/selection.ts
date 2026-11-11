/**
 * Sélection du modèle : 3 candidats à l'achat, 3 à la vente, parmi les tokens
 * dont les revenus ont un sens comme base de valorisation.
 *
 * Classement MÉCANIQUE et transparent : six critères publics, pondérés,
 * chacun ramené entre −1 (défavorable) et +1 (favorable). Ce n'est pas un
 * conseil en investissement, et le modèle n'a pas été validé sur l'historique
 * (il faudrait des séries de revenus et de capitalisation sur plusieurs années).
 */
import { fmtMultiple, holdersShare, liveValuation, median, revenueTrend, TAB_LABELS, type RevenueRow, type RevenueTab } from "./revenue";

/** Les L1/L2 se valorisent sur d'autres ressorts (prime monétaire, staking) que les frais : exclues. */
export const EXCLUDED_TABS: RevenueTab[] = ["l1", "l2"];
/** En dessous, un multiple ne veut plus dire grand-chose et le marché est trop étroit. */
export const MIN_MCAP = 50e6;
export const MIN_ANNUAL_REVENUE = 1e6;
/** Médiane de catégorie seulement à partir de ce nombre de pairs, sinon médiane globale. */
const MIN_PEERS = 3;

export type FactorKey = "value" | "revenueTrend" | "priceTrend" | "accrual" | "dilution" | "funding";

export const WEIGHTS: Record<FactorKey, number> = {
  value: 0.35,
  revenueTrend: 0.2,
  priceTrend: 0.15,
  accrual: 0.15,
  dilution: 0.1,
  funding: 0.05,
};

export const FACTOR_LABELS: Record<FactorKey, string> = {
  value: "Valorisation relative (MC / revenus contre la médiane de la catégorie)",
  revenueTrend: "Dynamique des revenus (30 j contre les 30 précédents)",
  priceTrend: "Dynamique du prix (30 j)",
  accrual: "Part des revenus reversée aux détenteurs",
  dilution: "Dilution à venir (FDV / MC)",
  funding: "Positionnement (funding Hyperliquid : longs encombrés = défavorable)",
};

export interface Factor {
  key: FactorKey;
  /** Note entre −1 et +1. */
  value: number;
  /** Note × poids : sa part dans le score. */
  contribution: number;
  text: string;
}

export interface Scored {
  row: RevenueRow;
  score: number;
  mcRev: number;
  peerMedian: number;
  peerLabel: string;
  factors: Factor[];
}

export interface MarketContext {
  /** Prix en direct par symbole (perps Hyperliquid). */
  livePx: Record<string, number | undefined>;
  /** Funding annualisé par symbole. */
  fundingApr: Record<string, number | undefined>;
}

const clip = (x: number) => Math.max(-1, Math.min(1, x));
const pct = (x: number) => `${x >= 0 ? "+" : ""}${Math.round(x * 100)} %`;

export function scoreAll(rows: RevenueRow[], ctx: MarketContext): Scored[] {
  const base = rows.flatMap((row) => {
    if (row.listed !== "perp" || EXCLUDED_TABS.includes(row.tab)) return [];
    const { mcap, fdv } = liveValuation(row, ctx.livePx[row.symbol]);
    const annual = (row.rev_30d * 365) / 30;
    if (mcap === null || mcap < MIN_MCAP || annual < MIN_ANNUAL_REVENUE) return [];
    return [{ row, mcap, fdv, mcRev: mcap / annual }];
  });

  const globalMedian = median(base.map((b) => b.mcRev)) ?? 1;
  const byTab = new Map<RevenueTab, number[]>();
  for (const b of base) byTab.set(b.row.tab, [...(byTab.get(b.row.tab) ?? []), b.mcRev]);

  return base
    .map(({ row, mcap, fdv, mcRev }) => {
      const peers = byTab.get(row.tab) ?? [];
      const usePeers = peers.length >= MIN_PEERS;
      const peerMedian = usePeers ? (median(peers) as number) : globalMedian;
      const peerLabel = usePeers ? TAB_LABELS[row.tab] : "tous secteurs";
      const factors: Factor[] = [];
      const add = (key: FactorKey, value: number, text: string) =>
        factors.push({ key, value, contribution: value * WEIGHTS[key], text });

      // 4× moins cher que ses pairs → +1 ; 4× plus cher → −1 (échelle log).
      add(
        "value",
        clip(Math.log(peerMedian / mcRev) / Math.log(4)),
        `MC/rev. ${fmtMultiple(mcRev)} contre ${fmtMultiple(peerMedian)} (médiane ${peerLabel})`
      );

      const trend = revenueTrend(row);
      add("revenueTrend", trend === null ? 0 : clip(trend / 0.5), trend === null ? "tendance des revenus inconnue" : `revenus ${pct(trend)} sur 30 j`);

      const px = row.px_chg_30d ?? null;
      add("priceTrend", px === null ? 0 : clip(px / 0.5), px === null ? "variation du prix inconnue" : `prix ${pct(px)} sur 30 j`);

      const share = holdersShare(row);
      add(
        "accrual",
        share === null ? 0 : 2 * share - 1,
        share === null ? "part reversée non publiée" : share === 0 ? "rien n'est reversé aux détenteurs" : `${Math.round(share * 100)} % des revenus reversés aux détenteurs`
      );

      // FDV = MC → +1 ; FDV = 3 × MC → −1 (échelle log).
      const ratio = fdv !== null && mcap > 0 ? fdv / mcap : null;
      add(
        "dilution",
        ratio === null ? 0 : clip(1 - (2 * Math.log(Math.max(1, ratio))) / Math.log(3)),
        ratio === null ? "FDV inconnue" : ratio < 1.15 ? "presque toute l'offre circule déjà" : `FDV = ${ratio.toFixed(1)} × MC : dilution à venir`
      );

      // Funding très positif : les longs paient cher, position encombrée.
      const apr = ctx.fundingApr[row.symbol];
      add(
        "funding",
        apr === undefined ? 0 : clip(-apr / 0.5),
        apr === undefined ? "funding inconnu" : `funding ${pct(apr)}/an (${apr > 0 ? "longs payeurs" : apr < 0 ? "shorts payeurs" : "neutre"})`
      );

      const score = factors.reduce((s, f) => s + f.contribution, 0);
      return { row, score, mcRev, peerMedian, peerLabel, factors };
    })
    .sort((a, b) => b.score - a.score);
}

/** Les n meilleurs scores positifs et les n pires négatifs, sans recouvrement. */
export function pick(scored: Scored[], n = 3): { buy: Scored[]; sell: Scored[] } {
  const buy = scored.filter((s) => s.score > 0).slice(0, n);
  const sell = scored
    .filter((s) => s.score < 0 && !buy.includes(s))
    .slice(-n)
    .reverse();
  return { buy, sell };
}

/** Les raisons qui pèsent le plus dans le sens du classement. */
export function reasons(s: Scored, side: "buy" | "sell", n = 3): Factor[] {
  const sign = side === "buy" ? 1 : -1;
  return [...s.factors]
    .filter((f) => f.contribution * sign > 0.01)
    .sort((a, b) => (b.contribution - a.contribution) * sign)
    .slice(0, n);
}
