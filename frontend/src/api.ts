import type {
  Alert,
  Candle,
  ConfluenceResponse,
  FundingPoint,
  MarketsResponse,
} from "./types";

// En dev, le proxy Vite renvoie /api vers uvicorn (cf. vite.config.ts).
// En production sur Vercel, l'API est servie sur la même origine que le front,
// donc une base vide convient. VITE_API_BASE permet de pointer un backend
// distant si le front est déployé séparément.
const BASE = import.meta.env.VITE_API_BASE ?? "";

async function getJson<T>(path: string): Promise<T> {
  const resp = await fetch(`${BASE}${path}`);
  if (!resp.ok) {
    throw new Error(`API ${resp.status}: ${await resp.text()}`);
  }
  return resp.json() as Promise<T>;
}

export const api = {
  markets: () => getJson<MarketsResponse>("/api/markets"),
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
  ackAll: async (): Promise<{ acknowledged: number }> => {
    const resp = await fetch(`${BASE}/api/alerts/ack-all`, { method: "POST" });
    if (!resp.ok) throw new Error(`API ${resp.status}`);
    return resp.json();
  },
};
