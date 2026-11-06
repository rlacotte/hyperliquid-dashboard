/**
 * Smart money : profils du leaderboard, positionnement agrégé des traders
 * suivis, et carte de leurs niveaux de liquidation.
 */
import { num, type ClearinghouseState } from "./hl/client";

export type Profile = "consistent" | "directional" | "rebound" | "market_maker" | "passive";

/** Ligne compacte renvoyée par /api/leaderboard (cf. backend/app/leaderboard.py). */
export interface LeaderRow {
  a: string; // adresse
  n: string | null; // nom affiché
  av: number; // valeur du compte
  pd: number; // PnL jour
  pw: number; // PnL semaine
  pm: number; // PnL 30 j
  pa: number; // PnL historique
  rw: number; // ROI semaine
  rm: number; // ROI 30 j
  ra: number; // ROI historique
  vm: number; // volume 30 j
  va: number; // volume historique
  pr: Profile;
}

export const PROFILES: Record<Profile, { label: string; tone: string; help: string }> = {
  consistent: {
    label: "Régulier",
    tone: "bg-green-500/15 text-green-300",
    help: "Gagnant sur la semaine, le mois ET tout son historique.",
  },
  directional: {
    label: "Directionnel",
    tone: "bg-blue-500/15 text-blue-300",
    help: "Trader actif sans régularité établie sur toutes les fenêtres.",
  },
  rebound: {
    label: "Rebond",
    tone: "bg-amber-500/15 text-amber-300",
    help: "Gagnant sur 30 jours mais perdant sur tout son historique : un bon mois ne fait pas un bon trader.",
  },
  market_maker: {
    label: "Teneur de marché",
    tone: "bg-gray-500/20 text-gray-300",
    help: "Rotation mensuelle ≥ 200× son capital pour moins de 25 points de base de PnL par dollar échangé : il fournit de la liquidité, il ne parie pas sur le prix.",
  },
  passive: {
    label: "Passif",
    tone: "bg-purple-500/15 text-purple-300",
    help: "A échangé moins de la moitié de son capital en 30 jours : son PnL vient d'actifs détenus (spot, vaults), pas du trading.",
  },
};

/** PnL par dollar échangé, en points de base : la « marge » réelle du trader. */
export const edgeBp = (r: LeaderRow): number | null => (r.vm > 0 ? (r.pm / r.vm) * 1e4 : null);

// --- Positionnement agrégé -----------------------------------------------------

export interface CoinBias {
  coin: string;
  longUsd: number;
  shortUsd: number;
  longTraders: number;
  shortTraders: number;
  /** (long − short) / (long + short) ∈ [−1, 1]. */
  bias: number;
}

export interface TrackedPosition {
  address: string;
  coin: string;
  side: "long" | "short";
  notional: number;
  entryPx: number;
  liqPx: number | null;
  leverage: number;
}

export function extractPositions(states: { address: string; state: ClearinghouseState }[]): TrackedPosition[] {
  const out: TrackedPosition[] = [];
  for (const { address, state } of states) {
    for (const { position: p } of state.assetPositions) {
      const szi = num(p.szi);
      if (szi === 0) continue;
      out.push({
        address,
        coin: p.coin,
        side: szi > 0 ? "long" : "short",
        notional: Math.abs(num(p.positionValue)),
        entryPx: num(p.entryPx),
        liqPx: p.liquidationPx === null ? null : num(p.liquidationPx),
        leverage: p.leverage.value,
      });
    }
  }
  return out;
}

export function aggregateBias(positions: TrackedPosition[]): CoinBias[] {
  const by = new Map<string, CoinBias>();
  for (const p of positions) {
    let b = by.get(p.coin);
    if (!b) by.set(p.coin, (b = { coin: p.coin, longUsd: 0, shortUsd: 0, longTraders: 0, shortTraders: 0, bias: 0 }));
    if (p.side === "long") {
      b.longUsd += p.notional;
      b.longTraders += 1;
    } else {
      b.shortUsd += p.notional;
      b.shortTraders += 1;
    }
  }
  for (const b of by.values()) {
    const gross = b.longUsd + b.shortUsd;
    b.bias = gross > 0 ? (b.longUsd - b.shortUsd) / gross : 0;
  }
  return [...by.values()].sort((x, y) => y.longUsd + y.shortUsd - (x.longUsd + x.shortUsd));
}

// --- Échelle de liquidations ----------------------------------------------------

export interface LiqBucket {
  /** Borne basse du palier, en écart relatif au prix courant (−0.10 = −10 %). */
  fromPct: number;
  toPct: number;
  longUsd: number;
  shortUsd: number;
  count: number;
}

/**
 * Regroupe les prix de liquidation des positions suivies en paliers autour du
 * prix courant. Sous le prix : des LONGS (liquidés si le prix baisse) ; au-dessus :
 * des SHORTS. Un gros palier proche agit comme un aimant : sa liquidation forcée
 * alimente le mouvement qui l'a déclenchée.
 *
 * Positions sans prix de liquidation (cross couvert par le reste du compte) et
 * hors de la plage ignorées.
 */
export function liquidationLadder(positions: TrackedPosition[], price: number, rangePct = 0.3, stepPct = 0.02): LiqBucket[] {
  const n = Math.round((2 * rangePct) / stepPct);
  const buckets: LiqBucket[] = Array.from({ length: n }, (_, i) => {
    const from = -rangePct + i * stepPct;
    return { fromPct: from, toPct: from + stepPct, longUsd: 0, shortUsd: 0, count: 0 };
  });
  if (price <= 0) return buckets;
  for (const p of positions) {
    if (p.liqPx === null || p.liqPx <= 0) continue;
    const rel = (p.liqPx - price) / price;
    if (rel < -rangePct || rel >= rangePct) continue;
    const idx = Math.min(n - 1, Math.floor((rel + rangePct) / stepPct));
    const b = buckets[idx];
    if (p.side === "long") b.longUsd += p.notional;
    else b.shortUsd += p.notional;
    b.count += 1;
  }
  return buckets;
}

// --- Récupération groupée ---------------------------------------------------------

/** Exécute `fn` sur chaque élément avec une concurrence bornée. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i]) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
