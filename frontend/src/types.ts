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
  | "confluence";
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
}

export interface ConfluenceScore {
  coin: string;
  score: number; // [-10, +10]
  direction: Direction;
  active_count: number;
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
