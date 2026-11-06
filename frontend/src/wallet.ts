/**
 * Logique pure de l'explorateur de wallet : métriques de position, distance à
 * la liquidation, décomposition du PnL et liste de suivi.
 */
import { num, type Position } from "./hl/client";

export const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export const isAddress = (s: string): boolean => ADDRESS_RE.test(s.trim());

export const shortAddr = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

export interface PositionView {
  coin: string;
  dex: string;
  side: "long" | "short";
  size: number;
  entryPx: number;
  markPx: number;
  notional: number;
  /** PnL latent recalculé au prix courant (le champ API date du dernier polling). */
  upnl: number;
  /** Rendement sur la marge engagée. */
  roe: number;
  leverage: number;
  leverageType: "cross" | "isolated";
  liqPx: number | null;
  /**
   * Mouvement de prix défavorable, en fraction du prix courant, qui déclenche la
   * liquidation. null si l'API ne donne pas de prix de liquidation (position
   * couverte par le reste du compte en cross).
   */
  liqDistance: number | null;
  marginUsed: number;
  fundingSinceOpen: number;
}

export function positionView(p: Position, dex: string, livePx: number | undefined): PositionView {
  const size = num(p.szi);
  const entryPx = num(p.entryPx);
  const marginUsed = num(p.marginUsed);
  // Sans prix en direct, on retombe sur le prix implicite de l'API.
  const apiMark = size !== 0 ? num(p.positionValue) / Math.abs(size) : entryPx;
  const markPx = livePx ?? apiMark;
  const upnl = size * (markPx - entryPx);
  const liqPx = p.liquidationPx === null ? null : num(p.liquidationPx);

  let liqDistance: number | null = null;
  if (liqPx !== null && liqPx > 0 && markPx > 0) {
    // Long : liquidé si le prix BAISSE jusqu'à liqPx ; short : s'il MONTE.
    liqDistance = size > 0 ? (markPx - liqPx) / markPx : (liqPx - markPx) / markPx;
  }

  return {
    coin: p.coin,
    dex,
    side: size >= 0 ? "long" : "short",
    size: Math.abs(size),
    entryPx,
    markPx,
    notional: Math.abs(size) * markPx,
    upnl,
    roe: marginUsed > 0 ? upnl / marginUsed : 0,
    leverage: p.leverage.value,
    leverageType: p.leverage.type,
    liqPx,
    liqDistance,
    marginUsed,
    // cumFunding est compté du point de vue du COMPTE PAYEUR : positif = payé.
    fundingSinceOpen: -num(p.cumFunding?.sinceOpen),
  };
}

/** Sévérité de la distance à la liquidation, pour la couleur. */
export function liqRisk(distance: number | null): "none" | "low" | "medium" | "high" {
  if (distance === null) return "none";
  if (distance < 0.05) return "high";
  if (distance < 0.15) return "medium";
  return "low";
}

// --- Décomposition du PnL ---------------------------------------------------------

export interface FundingEntry {
  time: number;
  delta: { coin: string; usdc: string };
}

export interface PnlBreakdown {
  total: number;
  funding: number;
  /** Total − funding : PnL directionnel, frais de trading inclus. */
  trading: number;
  /** Fraction de la fenêtre couverte par les paiements de funding récupérés. */
  fundingCoverage: number;
}

/**
 * Sépare ce qu'un trader gagne en PARIANT sur le prix de ce qu'il encaisse en
 * FUNDING. Les leaderboards affichent un PnL unique : un compte qui porte un
 * gros short pendant un funding positif « gagne » sans avoir eu raison sur le
 * marché — c'est l'une des confusions relevées dans la veille.
 *
 * `fundingCoverage` < 1 signifie que la pagination s'est arrêtée avant la fin
 * de la fenêtre (budget de débit) : la part funding est alors un minorant
 * en valeur absolue, et l'interface doit le dire.
 */
export function pnlBreakdown(
  totalPnl: number,
  funding: FundingEntry[],
  windowStart: number,
  windowEnd: number,
  complete: boolean
): PnlBreakdown {
  const fundingSum = funding.reduce((s, f) => s + num(f.delta.usdc), 0);
  let coverage = 1;
  if (!complete && funding.length > 0) {
    const last = funding[funding.length - 1].time;
    coverage = Math.max(0, Math.min(1, (last - windowStart) / (windowEnd - windowStart)));
  }
  return { total: totalPnl, funding: fundingSum, trading: totalPnl - fundingSum, fundingCoverage: coverage };
}

// --- Liste de suivi ---------------------------------------------------------------

export interface WatchedWallet {
  address: string;
  label: string;
  addedAt: number;
}

const WATCH_KEY = "hl-dashboard:watchlist";

/**
 * Persistée dans le navigateur : c'est une commodité personnelle, pas une donnée
 * partagée. Accès protégés — navigation privée ou stockage bloqué ne doivent
 * pas casser la page.
 */
export function loadWatchlist(): WatchedWallet[] {
  try {
    const raw = localStorage.getItem(WATCH_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((w) => w && isAddress(w.address)) : [];
  } catch {
    return [];
  }
}

export function saveWatchlist(list: WatchedWallet[]): void {
  try {
    localStorage.setItem(WATCH_KEY, JSON.stringify(list));
  } catch {
    /* stockage indisponible : la liste reste en mémoire pour la session */
  }
}
