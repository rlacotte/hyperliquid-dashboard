/**
 * Arbitrage de funding Hyperliquid ↔ Binance ↔ Bybit.
 *
 * Principe : une position delta-neutre (short sur la plateforme qui paie le
 * funding le plus élevé, long sur celle qui paie le plus bas) encaisse la
 * différence de taux sans exposition au prix.
 *
 * Deux pièges que ce module traite :
 * - les PÉRIODES diffèrent : Hyperliquid paie toutes les heures, Binance et
 *   Bybit toutes les 4 ou 8 h selon la paire. Comparer des taux bruts compare
 *   des choses incomparables ; tout est donc annualisé (APR) avant calcul ;
 * - les FRAIS : un écart de 15 %/an paraît énorme, mais l'aller-retour sur deux
 *   plateformes coûte ~0,2 % du notionnel. D'où le seuil de rentabilité en
 *   jours, plus parlant qu'un APR brut.
 */

export type Venue = "HlPerp" | "BinPerp" | "BybitPerp";

export const VENUES: Venue[] = ["HlPerp", "BinPerp", "BybitPerp"];

export const VENUE_LABEL: Record<Venue, string> = {
  HlPerp: "Hyperliquid",
  BinPerp: "Binance",
  BybitPerp: "Bybit",
};

export type FeeMode = "taker" | "maker";

/**
 * Frais au palier de base (sans remise de volume ni de staking).
 * Hyperliquid : 0,045 % / 0,015 % ; Binance USDⓈ-M : 0,05 % / 0,02 % ;
 * Bybit : 0,055 % / 0,02 %. Les marchés HIP-3 facturent le double, mais ils ne
 * sont pas listés sur Binance/Bybit et n'entrent donc pas dans ce calcul.
 */
export const FEES: Record<FeeMode, Record<Venue, number>> = {
  taker: { HlPerp: 0.00045, BinPerp: 0.0005, BybitPerp: 0.00055 },
  maker: { HlPerp: 0.00015, BinPerp: 0.0002, BybitPerp: 0.0002 },
};

export interface VenueRate {
  venue: Venue;
  /** Taux par période de financement (fraction). */
  rate: number;
  intervalHours: number;
  /** Taux annualisé. */
  apr: number;
  nextFundingTime: number;
}

export interface ArbRow {
  coin: string;
  rates: Partial<Record<Venue, VenueRate>>;
  /** Jambe à shorter : celle qui paie le funding le plus élevé. */
  short: VenueRate | null;
  /** Jambe à acheter : celle qui paie le funding le plus bas. */
  long: VenueRate | null;
  /** APR encaissé par la position delta-neutre (≥ 0). */
  spreadApr: number;
}

type RawPredicted = [string, [string, { fundingRate: string; nextFundingTime: number; fundingIntervalHours: number } | null][]][];

export const annualize = (rate: number, intervalHours: number): number =>
  intervalHours > 0 ? (rate / intervalHours) * 24 * 365 : 0;

/**
 * Construit une ligne par coin.
 * `requireHl` : la meilleure paire doit inclure Hyperliquid. C'est le cas par
 * défaut — un Binance↔Bybit est un arbitrage valide, mais pas notre sujet.
 */
export function buildArbRows(raw: RawPredicted, requireHl = true): ArbRow[] {
  const rows: ArbRow[] = [];
  for (const [coin, venues] of raw) {
    const rates: Partial<Record<Venue, VenueRate>> = {};
    for (const [name, v] of venues) {
      if (!v || !(VENUES as string[]).includes(name)) continue;
      const rate = parseFloat(v.fundingRate);
      if (!Number.isFinite(rate)) continue;
      const venue = name as Venue;
      rates[venue] = {
        venue,
        rate,
        intervalHours: v.fundingIntervalHours,
        apr: annualize(rate, v.fundingIntervalHours),
        nextFundingTime: v.nextFundingTime,
      };
    }
    rows.push({ coin, rates, ...bestPair(rates, requireHl) });
  }
  return rows;
}

export function bestPair(
  rates: Partial<Record<Venue, VenueRate>>,
  requireHl: boolean
): { short: VenueRate | null; long: VenueRate | null; spreadApr: number } {
  const available = VENUES.map((v) => rates[v]).filter((r): r is VenueRate => !!r);
  let best: { short: VenueRate; long: VenueRate; spreadApr: number } | null = null;

  for (let i = 0; i < available.length; i++) {
    for (let j = i + 1; j < available.length; j++) {
      const a = available[i];
      const b = available[j];
      if (requireHl && a.venue !== "HlPerp" && b.venue !== "HlPerp") continue;
      // On shorte où le funding est le plus haut : le short ENCAISSE quand le
      // taux est positif. On achète où il est le plus bas.
      const [short, long] = a.apr >= b.apr ? [a, b] : [b, a];
      const spreadApr = short.apr - long.apr;
      if (!best || spreadApr > best.spreadApr) best = { short, long, spreadApr };
    }
  }
  return best ?? { short: null, long: null, spreadApr: 0 };
}

/**
 * Prochaine échéance réelle de funding.
 *
 * `predictedFundings` renvoie pour Hyperliquid l'échéance de la période EN
 * COURS (09:00 alors qu'il est 09:31), constaté en direct. On avance donc
 * d'autant de périodes que nécessaire pour retomber dans le futur — correction
 * neutre pour les plateformes qui renvoient déjà une date future.
 */
export function nextFundingAfter(nextFundingTime: number, intervalHours: number, now: number): number {
  const period = intervalHours * 3600_000;
  if (period <= 0 || nextFundingTime > now) return nextFundingTime;
  const periodsBehind = Math.floor((now - nextFundingTime) / period) + 1;
  return nextFundingTime + periodsBehind * period;
}

/** Coût d'un aller-retour complet (ouverture + fermeture) sur les deux jambes. */
export function roundTripFee(short: Venue, long: Venue, mode: FeeMode): number {
  return 2 * (FEES[mode][short] + FEES[mode][long]);
}

/**
 * Nombre de jours de portage nécessaires pour que le funding encaissé couvre
 * les frais, en supposant l'écart constant. null si l'écart est nul.
 */
export function breakEvenDays(spreadApr: number, fee: number): number | null {
  if (spreadApr <= 0) return null;
  return fee / (spreadApr / 365);
}
