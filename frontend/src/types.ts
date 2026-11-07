export interface AssetMarket {
  coin: string;
  sz_decimals: number;
  max_leverage: number;
  mark_px: number;
  oracle_px: number;
  mid_px: number;
  funding: number;
  open_interest: number;
  open_interest_usd: number;
  prev_day_px: number;
  day_ntl_vlm: number;
  day_base_vlm: number;
  change_24h_pct: number;
}

export interface MarketsResponse {
  ts: number;
  assets: AssetMarket[];
}

export type Severity = "info" | "warning" | "critical";
export type Criterion =
  | "funding_rate"
  | "open_interest"
  | "volume"
  | "price_change"
  | "confluence"
  | "funding_arb";
export type Direction = "bullish" | "bearish" | "neutral";

export interface Alert {
  id: number;
  coin: string;
  ts: number;
  criterion: Criterion;
  severity: Severity;
  message: string;
  details: Record<string, unknown>;
  acknowledged: number;
  resolved_ts: number | null;
  active: number;
  score: number | null;
  direction: Direction | null;
}

export interface SignalScore {
  criterion: Criterion;
  score: number; // [-1, +1]
  direction: Direction;
  label: string;
  value: number;
  active?: boolean; // vrai si le critère contribue au score
}

export interface ConfluenceScore {
  coin: string;
  score: number; // [-10, +10]
  direction: Direction;
  active_count: number;
  regime: string;            // "strong_bull" | "strong_bear" | "short_covering" | "exhaustion" | "none"
  regime_label: string;      // libellé lisible
  confidence: number;        // fiabilité [0, 1]
  volume_confirmed: boolean;
  breakdown: SignalScore[];
}

export interface ConfluenceResponse {
  ts: number;
  scores: ConfluenceScore[];
}

export interface Candle {
  t: number; // ms
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface FundingPoint {
  time: number; // ms
  funding: number;
}

export interface FearGreed {
  value: number; // 0-100
  label: string; // "Extreme Fear" | "Fear" | "Neutral" | "Greed" | "Extreme Greed"
  history: number[];
  ts: number;
}

export interface CoinGeckoGlobal {
  total_marketcap_usd: number;
  btc_dominance: number;
  eth_dominance: number;
  total_volume_usd: number;
  marketcap_change_24h_pct: number;
}

export interface GlobalMetrics {
  ts: number;
  fear_greed: FearGreed | null;
  coingecko: CoinGeckoGlobal | null;
  hl_open_interest_usd: number;
  hl_volume_24h_usd: number;
  hl_avg_funding: number;
  hl_advance_count: number;
  hl_decline_count: number;
  prev: Record<string, number | null>;
}

export interface HistoryPoint {
  t: number;
  v: number;
}
