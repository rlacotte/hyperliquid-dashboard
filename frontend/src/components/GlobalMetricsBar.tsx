import type { GlobalMetrics } from "../types";
import { usePolling } from "../hooks/usePolling";
import { api } from "../api";
import { Sparkline } from "./Sparkline";
import { fearGreedBgColor, fearGreedColor, fmtPct, fmtUsd, fmtUsdLarge } from "../format";

interface MetricCardProps {
  icon: string;
  label: string;
  children: React.ReactNode;
  sparklineValues?: number[];
  sparklineColor?: string;
}

function MetricCard({ icon, label, children, sparklineValues, sparklineColor }: MetricCardProps) {
  return (
    <div className="flex min-w-[140px] flex-1 flex-col gap-1 rounded-lg border border-bg-border bg-bg-panel p-3">
      <div className="flex items-center gap-1.5 text-xs text-gray-500">
        <span>{icon}</span>
        <span className="truncate">{label}</span>
      </div>
      <div className="flex items-end justify-between gap-2">
        <div className="min-w-0 flex-1">{children}</div>
        {sparklineValues && sparklineValues.length >= 2 && (
          <Sparkline values={sparklineValues} color={sparklineColor} width={60} height={20} />
        )}
      </div>
    </div>
  );
}

function Delta({ value, prev, suffix = "" }: { value: number; prev: number | null | undefined; suffix?: string }) {
  if (prev === null || prev === undefined || prev === 0) return null;
  const delta = value - prev;
  const pct = (delta / prev) * 100;
  if (Math.abs(pct) < 0.01) return null;
  const color = delta >= 0 ? "text-green-400" : "text-red-400";
  const arrow = delta >= 0 ? "▲" : "▼";
  return (
    <span className={`text-[10px] ${color}`}>
      {arrow} {Math.abs(pct).toFixed(2)}%{suffix}
    </span>
  );
}

export function GlobalMetricsBar() {
  const { data, error } = usePolling(() => api.globalMetrics(), 30000);

  if (error && !data) {
    return (
      <div className="border-b border-bg-border bg-bg-panel px-4 py-2 text-xs text-red-400">
        Erreur métriques globales : {error}
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex gap-2 overflow-x-auto border-b border-bg-border bg-bg-panel px-4 py-2">
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="h-16 min-w-[140px] flex-1 animate-pulse rounded-lg bg-bg-hover" />
        ))}
      </div>
    );
  }

  const fng = data.fear_greed;
  const cg = data.coingecko;
  const total = data.hl_advance_count + data.hl_decline_count;
  const advancePct = total > 0 ? (data.hl_advance_count / total) * 100 : 50;

  return (
    <div className="flex gap-2 overflow-x-auto border-b border-bg-border bg-bg-panel px-4 py-2">
      {/* Fear & Greed */}
      <MetricCard
        icon="😱"
        label="Fear & Greed"
        sparklineValues={fng?.history.slice(-20)}
        sparklineColor={fng ? (fng.value <= 45 ? "#f97316" : fng.value >= 55 ? "#84cc16" : "#eab308") : "#6b7280"}
      >
        {fng ? (
          <div className="flex items-baseline gap-2">
            <span className={`text-xl font-bold ${fearGreedColor(fng.value)}`}>{fng.value}</span>
            <div>
              {/* Mini barre colorée 0-100 */}
              <div className="relative h-1.5 w-16 overflow-hidden rounded-full bg-gray-700">
                <div
                  className={`absolute h-full ${fearGreedBgColor(fng.value)}`}
                  style={{ width: `${fng.value}%` }}
                />
              </div>
              <div className="mt-0.5 text-[10px] text-gray-500">{fng.label}</div>
            </div>
          </div>
        ) : (
          <span className="text-sm text-gray-600">N/A</span>
        )}
      </MetricCard>

      {/* Total Marketcap */}
      <MetricCard
        icon="🌐"
        label="Marketcap"
        sparklineColor="#60a5fa"
        sparklineValues={undefined} // historique pas encore fetché ici, on utilise fng.history pattern
      >
        {cg ? (
          <div>
            <div className="text-lg font-semibold text-gray-200">
              {fmtUsdLarge(cg.total_marketcap_usd)}
            </div>
            <Delta
              value={cg.total_marketcap_usd}
              prev={cg.total_marketcap_usd / (1 + cg.marketcap_change_24h_pct / 100)}
            />
          </div>
        ) : (
          <span className="text-sm text-gray-600">N/A</span>
        )}
      </MetricCard>

      {/* BTC Dominance */}
      <MetricCard icon="₿" label="BTC Dominance" sparklineColor="#f59e0b">
        {cg ? (
          <div>
            <div className="text-lg font-semibold text-orange-400">
              {cg.btc_dominance.toFixed(1)}%
            </div>
            <div className="text-[10px] text-gray-500">ETH {cg.eth_dominance.toFixed(1)}%</div>
          </div>
        ) : (
          <span className="text-sm text-gray-600">N/A</span>
        )}
      </MetricCard>

      {/* OI totale Hyperliquid */}
      <MetricCard
        icon="📈"
        label="OI Totale HL"
        sparklineColor="#a78bfa"
        sparklineValues={undefined}
      >
        <div>
          <div className="text-lg font-semibold text-gray-200">
            {fmtUsdLarge(data.hl_open_interest_usd)}
          </div>
          <Delta value={data.hl_open_interest_usd} prev={data.prev?.hl_open_interest_usd} />
        </div>
      </MetricCard>

      {/* Volume 24h Hyperliquid */}
      <MetricCard
        icon="📊"
        label="Volume 24h HL"
        sparklineColor="#34d399"
        sparklineValues={undefined}
      >
        <div>
          <div className="text-lg font-semibold text-gray-200">
            {fmtUsdLarge(data.hl_volume_24h_usd)}
          </div>
          <Delta value={data.hl_volume_24h_usd} prev={data.prev?.hl_volume_24h_usd} />
        </div>
      </MetricCard>

      {/* Funding moyen */}
      <MetricCard icon="💸" label="Funding moy." sparklineColor="#f472b6">
        <div>
          <div
            className={`text-lg font-semibold font-mono ${
              data.hl_avg_funding >= 0 ? "text-green-400" : "text-red-400"
            }`}
          >
            {(data.hl_avg_funding * 100).toFixed(4)}%
          </div>
          <div className="text-[10px] text-gray-500">
            {data.hl_avg_funding >= 0 ? "longs paient" : "shorts paient"}
          </div>
        </div>
      </MetricCard>

      {/* Advance/Decline */}
      <MetricCard icon="⚖️" label="A/D 24h">
        <div>
          <div className="flex items-baseline gap-1.5">
            <span className="text-sm font-semibold text-green-400">{data.hl_advance_count}</span>
            <span className="text-[10px] text-gray-600">/</span>
            <span className="text-sm font-semibold text-red-400">{data.hl_decline_count}</span>
          </div>
          {/* Barre proportionnelle */}
          <div className="mt-1 flex h-1.5 w-full overflow-hidden rounded-full bg-red-500/30">
            <div className="h-full bg-green-500" style={{ width: `${advancePct}%` }} />
          </div>
          <div className="mt-0.5 text-[10px] text-gray-500">
            {advancePct.toFixed(0)}% haussiers
          </div>
        </div>
      </MetricCard>
    </div>
  );
}
