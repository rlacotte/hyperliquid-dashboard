import { useEffect, useState } from "react";
import { api } from "../api";
import type { AssetMarket, Candle, ConfluenceScore, FundingPoint } from "../types";
import { colorPct, fmtFunding, fmtPct, fmtPrice, fmtUsd } from "../format";
import { PriceChart } from "./PriceChart";
import { FundingChart } from "./FundingChart";
import { ConfluenceGauge } from "./ConfluenceGauge";

interface Props {
  coin: string;
  asset: AssetMarket | undefined;
  confluence: ConfluenceScore | undefined;
  onClose: () => void;
}

type Interval = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

export function AssetDetail({ coin, asset, confluence, onClose }: Props) {
  const [candles, setCandles] = useState<Candle[]>([]);
  const [funding, setFunding] = useState<FundingPoint[]>([]);
  const [interval, setInterval_] = useState<Interval>("1h");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      api.candles(coin, interval, 24),
      api.funding(coin, 72),
    ])
      .then(([c, f]) => {
        if (!cancelled) {
          setCandles(c);
          setFunding(f);
        }
      })
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [coin, interval]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-bg-border bg-bg-panel"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-4 border-b border-bg-border p-4">
          <h2 className="text-xl font-bold text-white">{coin}</h2>
          {asset && (
            <div className="flex items-center gap-4 text-sm">
              <span className="text-gray-300">{fmtPrice(asset.mark_px)}</span>
              <span className={`font-mono ${colorPct(asset.change_24h_pct)}`}>
                {fmtPct(asset.change_24h_pct)}
              </span>
              <span className="text-gray-500">|</span>
              <span className="text-gray-400">
                Funding: <span className={`font-mono ${colorPct(asset.funding)}`}>{fmtFunding(asset.funding)}</span>
              </span>
              <span className="text-gray-400">
                OI: <span className="text-gray-200">{fmtUsd(asset.open_interest_usd)}</span>
              </span>
              <span className="text-gray-400">
                Vol: <span className="text-gray-200">{fmtUsd(asset.day_ntl_vlm)}</span>
              </span>
            </div>
          )}
          <button
            onClick={onClose}
            className="ml-auto rounded-md px-3 py-1 text-gray-400 hover:bg-bg-hover hover:text-white"
          >
            ✕
          </button>
        </div>

        {/* Contenu */}
        <div className="flex-1 overflow-auto p-4">
          {loading ? (
            <div className="flex h-64 items-center justify-center text-gray-500">Chargement...</div>
          ) : (
            <div className="space-y-6">
              {/* Score de confluence */}
              {confluence && (
                <div>
                  <h3 className="mb-2 text-sm font-medium text-gray-300">Score de confluence</h3>
                  <ConfluenceGauge confluence={confluence} />
                </div>
              )}

              {/* Candles */}
              <div>
                <div className="mb-2 flex items-center gap-2">
                  <h3 className="text-sm font-medium text-gray-300">Prix (24h)</h3>
                  <div className="ml-auto flex gap-1">
                    {(["5m", "15m", "1h", "4h", "1d"] as Interval[]).map((iv) => (
                      <button
                        key={iv}
                        onClick={() => setInterval_(iv)}
                        className={`rounded px-2 py-1 text-xs ${
                          interval === iv
                            ? "bg-blue-600 text-white"
                            : "bg-bg-hover text-gray-400 hover:text-white"
                        }`}
                      >
                        {iv}
                      </button>
                    ))}
                  </div>
                </div>
                <PriceChart candles={candles} />
              </div>

              {/* Funding */}
              <div>
                <h3 className="mb-2 text-sm font-medium text-gray-300">Funding rate (72h)</h3>
                <FundingChart data={funding} />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
