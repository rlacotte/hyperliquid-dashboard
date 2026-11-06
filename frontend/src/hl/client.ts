/**
 * Client REST Hyperliquid, appelé DIRECTEMENT depuis le navigateur.
 *
 * L'endpoint public /info renvoie `Access-Control-Allow-Origin: *` : aucun proxy
 * n'est nécessaire. C'est un choix d'architecture, pas un raccourci :
 * - la donnée d'affichage reste fraîche même si la collecte serveur s'arrête ;
 * - les recherches par wallet ne chargent ni la fonction Vercel ni la base
 *   Postgres partagée ;
 * - la limite de débit Hyperliquid (poids par IP et par minute) s'applique à
 *   chaque visiteur, pas à un backend commun qui saturerait pour tout le monde.
 *
 * Le backend garde ce qu'il est seul à pouvoir faire : l'historique, le moteur
 * d'alertes, les scores de confluence et le leaderboard distillé.
 */

const INFO_URL = "https://api.hyperliquid.xyz/info";

export class HlError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export async function info<T>(body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const resp = await fetch(INFO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!resp.ok) {
    throw new HlError(`Hyperliquid ${resp.status}: ${await resp.text()}`, resp.status);
  }
  return resp.json() as Promise<T>;
}

/** Hyperliquid encode tous les nombres en chaînes. */
export const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
};
export const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
};

// --- Types bruts (sous-ensemble utilisé) --------------------------------------
export interface RawPerpMeta {
  universe: { name: string; szDecimals: number; maxLeverage: number; isDelisted?: boolean; onlyIsolated?: boolean }[];
}
export interface RawPerpCtx {
  funding: string;
  openInterest: string;
  prevDayPx: string;
  dayNtlVlm: string;
  premium: string | null;
  oraclePx: string;
  markPx: string;
  midPx: string | null;
  impactPxs: string[] | null;
  dayBaseVlm: string;
}
export interface RawSpotMeta {
  tokens: { name: string; index: number; szDecimals: number; fullName?: string | null }[];
  universe: { name: string; tokens: [number, number]; index: number; isCanonical?: boolean }[];
}
export interface RawSpotCtx {
  coin: string;
  markPx: string;
  midPx: string | null;
  prevDayPx: string;
  dayNtlVlm: string;
  circulatingSupply?: string;
  totalSupply?: string;
}

// --- Modèle unifié ------------------------------------------------------------
export type MarketKind = "perp" | "hip3" | "spot";

export interface Market {
  /** Identifiant Hyperliquid du coin : "BTC", "xyz:TSLA", "@107", "PURR/USDC". */
  id: string;
  /** Libellé affiché : "BTC", "TSLA", "HYPE/USDC". */
  name: string;
  kind: MarketKind;
  /** "" pour le DEX principal, sinon le nom du DEX HIP-3. */
  dex: string;
  markPx: number;
  prevDayPx: number;
  change24h: number;
  /** Taux horaire (perps uniquement). */
  funding: number | null;
  openInterestUsd: number | null;
  volume24h: number;
  maxLeverage: number | null;
  szDecimals: number;
  isDelisted: boolean;
}

const change = (mark: number, prev: number) => (prev > 0 ? (mark - prev) / prev : 0);

function perpMarkets(meta: RawPerpMeta, ctxs: RawPerpCtx[], dex: string): Market[] {
  const out: Market[] = [];
  meta.universe.forEach((u, i) => {
    const c = ctxs[i];
    if (!c) return;
    const markPx = num(c.markPx);
    const prevDayPx = num(c.prevDayPx);
    out.push({
      id: u.name,
      // Les marchés HIP-3 sont préfixés par leur DEX ("xyz:TSLA") : on garde
      // le préfixe dans l'id (c'est la clé API) mais pas dans le libellé.
      name: dex ? u.name.slice(dex.length + 1) : u.name,
      kind: dex ? "hip3" : "perp",
      dex,
      markPx,
      prevDayPx,
      change24h: change(markPx, prevDayPx),
      funding: num(c.funding),
      openInterestUsd: num(c.openInterest) * markPx,
      volume24h: num(c.dayNtlVlm),
      maxLeverage: u.maxLeverage,
      szDecimals: u.szDecimals,
      isDelisted: Boolean(u.isDelisted),
    });
  });
  return out;
}

function spotMarkets(meta: RawSpotMeta, ctxs: RawSpotCtx[]): Market[] {
  const tokenName = new Map(meta.tokens.map((t) => [t.index, t.name]));
  const pairByName = new Map(meta.universe.map((u) => [u.name, u]));
  const out: Market[] = [];
  for (const c of ctxs) {
    // Les contextes ne sont pas alignés positionnellement sur l'univers (leurs
    // longueurs diffèrent) : on rapproche par nom de paire.
    const pair = pairByName.get(c.coin);
    if (!pair) continue;
    const [base, quote] = pair.tokens;
    const markPx = num(c.markPx);
    const prevDayPx = num(c.prevDayPx);
    out.push({
      id: c.coin,
      name: `${tokenName.get(base) ?? "?"}/${tokenName.get(quote) ?? "?"}`,
      kind: "spot",
      dex: "",
      markPx,
      prevDayPx,
      change24h: change(markPx, prevDayPx),
      funding: null,
      openInterestUsd: null,
      volume24h: num(c.dayNtlVlm),
      maxLeverage: null,
      szDecimals: 0,
      isDelisted: false,
    });
  }
  return out;
}

// --- Requêtes ------------------------------------------------------------------
const DEX_CACHE_MS = 10 * 60_000;
let dexCache: { at: number; names: string[] } | null = null;

export const hl = {
  perpDexs: () => info<({ name: string; fullName?: string } | null)[]>({ type: "perpDexs" }),

  perps: async (dex = ""): Promise<Market[]> => {
    const body: Record<string, unknown> = { type: "metaAndAssetCtxs" };
    if (dex) body.dex = dex;
    const [meta, ctxs] = await info<[RawPerpMeta, RawPerpCtx[]]>(body);
    return perpMarkets(meta, ctxs, dex);
  },

  spot: async (): Promise<Market[]> => {
    const [meta, ctxs] = await info<[RawSpotMeta, RawSpotCtx[]]>({ type: "spotMetaAndAssetCtxs" });
    return spotMarkets(meta, ctxs);
  },

  /** Noms des DEX HIP-3, mis en cache : la liste ne change qu'au déploiement d'un nouveau DEX. */
  dexNames: async (): Promise<string[]> => {
    if (dexCache && Date.now() - dexCache.at < DEX_CACHE_MS) return dexCache.names;
    const names = (await hl.perpDexs()).filter((d): d is { name: string } => !!d?.name).map((d) => d.name);
    dexCache = { at: Date.now(), names };
    return names;
  },

  /**
   * Tous les marchés, tous DEX confondus, en parallèle.
   *
   * Coût : ~20 de poids par DEX (limite Hyperliquid : 1200/min/IP). Les prix
   * arrivant par websocket — hors quota REST — cet appel ne sert qu'au
   * contexte lent (funding, OI, volume) : le rafraîchir toutes les 30 s suffit.
   */
  allMarkets: async (): Promise<Market[]> => {
    const dexs = await hl.dexNames();
    const results = await Promise.allSettled([hl.perps(""), hl.spot(), ...dexs.map((d) => hl.perps(d))]);
    // Un DEX HIP-3 en erreur ne doit pas vider tout le tableau.
    return results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  },

  oiCaps: () => info<string[]>({ type: "perpsAtOpenInterestCap" }),

  predictedFundings: () =>
    info<[string, [string, { fundingRate: string; nextFundingTime: number; fundingIntervalHours: number } | null][]][]>({
      type: "predictedFundings",
    }),

  clearinghouseState: (user: string, dex = "") =>
    info<ClearinghouseState>(dex ? { type: "clearinghouseState", user, dex } : { type: "clearinghouseState", user }),

  spotState: (user: string) => info<{ balances: SpotBalance[] }>({ type: "spotClearinghouseState", user }),

  portfolio: (user: string) => info<[PortfolioWindow, PortfolioSeries][]>({ type: "portfolio", user }),

  userFills: (user: string) => info<Fill[]>({ type: "userFills", user, aggregateByTime: true }),

  openOrders: (user: string) => info<OpenOrder[]>({ type: "frontendOpenOrders", user }),

  l2Book: (coin: string) => info<L2Book>({ type: "l2Book", coin }),

  candles: (coin: string, interval: string, startTime: number, endTime = Date.now()) =>
    info<RawCandle[]>({ type: "candleSnapshot", req: { coin, interval, startTime, endTime } }),

  fundingHistory: (coin: string, startTime: number, endTime = Date.now()) =>
    info<{ coin: string; fundingRate: string; premium: string; time: number }[]>({
      type: "fundingHistory",
      coin,
      startTime,
      endTime,
    }),
};

// --- Types de réponses utilisateur ----------------------------------------------
export interface Position {
  coin: string;
  szi: string;
  entryPx: string | null;
  positionValue: string;
  unrealizedPnl: string;
  returnOnEquity: string;
  liquidationPx: string | null;
  marginUsed: string;
  leverage: { type: "cross" | "isolated"; value: number };
  cumFunding?: { allTime: string; sinceOpen: string };
}
export interface ClearinghouseState {
  marginSummary: { accountValue: string; totalNtlPos: string; totalRawUsd: string; totalMarginUsed: string };
  crossMaintenanceMarginUsed: string;
  withdrawable: string;
  assetPositions: { type: string; position: Position }[];
  time: number;
}
export interface SpotBalance {
  coin: string;
  token: number;
  total: string;
  hold: string;
  entryNtl: string;
}
export type PortfolioWindow = "day" | "week" | "month" | "allTime" | "perpDay" | "perpWeek" | "perpMonth" | "perpAllTime";
export interface PortfolioSeries {
  accountValueHistory: [number, string][];
  pnlHistory: [number, string][];
  vlm: string;
}
export interface Fill {
  coin: string;
  px: string;
  sz: string;
  side: "A" | "B";
  time: number;
  startPosition: string;
  dir: string;
  closedPnl: string;
  hash: string;
  fee: string;
  crossed: boolean;
  liquidation?: { liquidatedUser?: string; markPx: string; method: string } | null;
}
export interface OpenOrder {
  coin: string;
  side: "A" | "B";
  limitPx: string;
  sz: string;
  origSz: string;
  oid: number;
  timestamp: number;
  orderType: string;
  reduceOnly: boolean;
  triggerPx?: string;
  isTrigger?: boolean;
}
export interface L2Level {
  px: string;
  sz: string;
  n: number;
}
export interface L2Book {
  coin: string;
  time: number;
  levels: [L2Level[], L2Level[]];
}
export interface RawCandle {
  t: number;
  T: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
  n: number;
}
export interface Trade {
  coin: string;
  side: "A" | "B";
  px: string;
  sz: string;
  time: number;
  hash: string;
  tid: number;
  users: [string, string];
}
