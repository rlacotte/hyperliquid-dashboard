import type {
  Alert,
  Candle,
  ConfluenceResponse,
  FundingPoint,
  GlobalMetrics,
  HistoryPoint,
  MarketsResponse,
} from "./types";

// En dev, le proxy Vite renvoie /api vers uvicorn (cf. vite.config.ts).
// En production sur Vercel, l'API est servie sur la même origine que le front,
// donc une base vide convient. VITE_API_BASE permet de pointer un backend
// distant si le front est déployé séparément.
const BASE = import.meta.env.VITE_API_BASE ?? "";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function getJson<T>(path: string): Promise<T> {
  const resp = await fetch(`${BASE}${path}`);
  if (!resp.ok) {
    throw new Error(`API ${resp.status}: ${await resp.text()}`);
  }
  return resp.json() as Promise<T>;
}

export const api = {
  markets: () => getJson<MarketsResponse>("/api/markets"),
  health: () =>
    getJson<{ status: string; last_fetch_ms: number; assets_count: number; poll_interval_sec: number }>("/api/health"),
  globalMetrics: () => getJson<GlobalMetrics>("/api/global-metrics"),
  trackRecord: () => getJson<import("./signals").TrackRecord>("/api/track-record"),
  revenue: () => getJson<import("./revenue").RevenueResponse>("/api/revenue"),
  fundingArb: () =>
    getJson<{
      ts: number | null;
      stale: boolean;
      track_min_apr?: number;
      coins: Record<string, { short: string; long: string; spread_apr: number; since: number; max_apr: number; last: number }>;
    }>("/api/funding-arb"),
  leaderboard: () =>
    getJson<{
      ts: number;
      total: number;
      rows: import("./smartmoney").LeaderRow[];
      snapshots: { days: number; since: string | null };
    }>("/api/leaderboard"),
  history: (metric: string, hours = 24) =>
    getJson<{ metric: string; points: HistoryPoint[] }>(
      `/api/global-metrics/history?metric=${metric}&hours=${hours}`
    ),
  confluence: (minScore = 0) =>
    getJson<ConfluenceResponse>(`/api/confluence?min_score=${minScore}`),
  candles: (coin: string, interval = "1h", hours = 24) =>
    getJson<Candle[]>(
      `/api/markets/${coin}/candles?interval=${interval}&hours=${hours}`
    ),
  funding: (coin: string, hours = 72) =>
    getJson<FundingPoint[]>(`/api/markets/${coin}/funding?hours=${hours}`),
  alerts: (limit = 100, onlyActive = true) =>
    getJson<Alert[]>(
      `/api/alerts?limit=${limit}&only_active=${onlyActive}`
    ),
  ackAlert: async (id: number): Promise<Alert> => {
    const resp = await fetch(`${BASE}/api/alerts/${id}/ack`, { method: "PATCH" });
    if (!resp.ok) throw new Error(`API ${resp.status}`);
    return resp.json();
  },
  telegram: {
    info: () => getJson<{ enabled: boolean; bot: string | null }>("/api/telegram/info"),
    create: (minNotional: number) =>
      sendJson<{ code: string; link: string; bot: string }>("POST", "/api/telegram/subscription", null, { min_notional: minNotional }),
    status: (code: string) => sendJson<TelegramSub>("GET", "/api/telegram/subscription", code),
    update: (code: string, body: { wallets: { address: string; label: string }[]; min_notional: number; critical_alerts: boolean }) =>
      sendJson<TelegramSub>("PUT", "/api/telegram/subscription", code, body),
    remove: (code: string) => sendJson<{ deleted: boolean }>("DELETE", "/api/telegram/subscription", code),
  },
  ackAll: async (): Promise<{ acknowledged: number }> => {
    const resp = await fetch(`${BASE}/api/alerts/ack-all`, { method: "POST" });
    if (!resp.ok) throw new Error(`API ${resp.status}`);
    return resp.json();
  },
};

export interface TelegramSub {
  linked: boolean;
  wallets: number;
  min_notional: number;
  critical_alerts: boolean;
}

/** Le code d'abonnement voyage en en-tête : les URLs finissent dans les journaux. */
async function sendJson<T>(method: string, path: string, code: string | null, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (code) headers["X-Subscription-Code"] = code;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const resp = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
  if (!resp.ok) {
    let detail = `${resp.status}`;
    try {
      detail = (await resp.json()).detail ?? detail;
    } catch {
      /* corps non JSON */
    }
    throw new ApiError(resp.status, String(detail));
  }
  return resp.json() as Promise<T>;
}
