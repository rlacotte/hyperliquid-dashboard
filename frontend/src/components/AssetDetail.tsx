import { useEffect, useState } from "react";
import { hl, num, type Market } from "../hl/client";
import type { Candle, ConfluenceScore, FundingPoint } from "../types";
import { colorPct, fmtApr, fmtFunding, fmtPct, fmtUsd, fundingApr } from "../format";
import { PriceChart } from "./PriceChart";
import { FundingChart } from "./FundingChart";
import { ConfluenceGauge } from "./ConfluenceGauge";
import { LivePrice } from "./LivePrice";

interface Props {
  market: Market;
  livePx: number | undefined;
  confluence: ConfluenceScore | undefined;
  onClose: () => void;
}

type Interval = "5m" | "15m" | "1h" | "4h" | "1d";

/**
 * Fenêtre affichée par intervalle : ~200-300 bougies, assez pour lire une
 * tendance sans écraser le détail. Une fenêtre fixe de 24 h donnait 1 seule
 * bougie en 1d et 6 en 4h.
 */
const WINDOW_H: Record<Interval, number> = { "5m": 24, "15m": 72, "1h": 24 * 10, "4h": 24 * 45, "1d": 24 * 300 };

export function AssetDetail({ market, livePx, confluence, onClose }: Props) {
  const [candles, setCandles] = useState<Candle[]>([]);
  const [funding, setFunding] = useState<FundingPoint[]>([]);
  const [interval, setInterval_] = useState<Interval>("1h");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isPerp = market.kind !== "spot";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const now = Date.now();
    Promise.all([
      hl.candles(market.id, interval, now - WINDOW_H[interval] * 3600_000, now),
      isPerp ? hl.fundingHistory(market.id, now - 7 * 86400_000, now) : Promise.resolve([]),
    ])
      .then(([c, f]) => {
        if (cancelled) return;
        setCandles(c.map((k) => ({ t: k.t, o: num(k.o), h: num(k.h), l: num(k.l), c: num(k.c), v: num(k.v) })));
        setFunding((f ?? []).map((p) => ({ time: p.time, funding: num(p.fundingRate) })));
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [market.id, interval, isPerp]);

  const px = livePx ?? market.markPx;
  const chg = market.prevDayPx > 0 ? (px - market.prevDayPx) / market.prevDayPx : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-label={`Détail ${market.name}`}
        className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-bg-border bg-bg-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-bg-border p-4">
          <h2 className="text-xl font-bold text-white">
            {market.name}
            {market.kind === "hip3" && (
              <span className="ml-2 rounded bg-purple-500/15 px-1.5 py-0.5 align-middle text-xs font-medium uppercase text-purple-300">
                {market.dex}
              </span>
            )}
            {market.kind === "spot" && (
              <span className="ml-2 rounded bg-sky-500/15 px-1.5 py-0.5 align-middle text-xs font-medium uppercase text-sky-300">
                spot
              </span>
            )}
          </h2>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <LivePrice value={px} className="text-base font-semibold text-gray-100" />
            <span className={`tabular-nums ${colorPct(chg)}`}>{fmtPct(chg)}</span>
            {market.funding !== null && (
              <span className="text-gray-400">
                Funding{" "}
                <span className={`tabular-nums ${colorPct(market.funding)}`}>{fmtFunding(market.funding)}</span>
                <span className="ml-1 text-xs text-gray-500">({fmtApr(fundingApr(market.funding))} /an)</span>
              </span>
            )}
            {market.openInterestUsd !== null && (
              <span className="text-gray-400">
                OI <span className="text-gray-200">{fmtUsd(market.openInterestUsd)}</span>
              </span>
            )}
            <span className="text-gray-400">
              Vol <span className="text-gray-200">{fmtUsd(market.volume24h)}</span>
            </span>
          </div>
          <button
            onClick={onClose}
            aria-label="Fermer"
            className="ml-auto rounded-md px-3 py-1 text-gray-400 hover:bg-bg-hover hover:text-white"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 space-y-6 overflow-auto p-4">
          {confluence && (
            <div>
              <h3 className="mb-2 text-sm font-medium text-gray-300">Score de confluence</h3>
              <ConfluenceGauge confluence={confluence} />
            </div>
          )}

          <div>
            <div className="mb-2 flex items-center gap-2">
              <h3 className="text-sm font-medium text-gray-300">Prix</h3>
              <div className="ml-auto flex gap-1">
                {(Object.keys(WINDOW_H) as Interval[]).map((iv) => (
                  <button
                    key={iv}
                    onClick={() => setInterval_(iv)}
                    className={`rounded px-2 py-1 text-xs ${
                      interval === iv ? "bg-blue-600 text-white" : "bg-bg-hover text-gray-400 hover:text-white"
                    }`}
                  >
                    {iv}
                  </button>
                ))}
              </div>
            </div>
            {error ? (
              <div className="flex h-[280px] items-center justify-center text-sm text-red-400">{error}</div>
            ) : loading && candles.length === 0 ? (
              <div className="flex h-[280px] items-center justify-center text-gray-500">Chargement…</div>
            ) : (
              <PriceChart candles={candles} />
            )}
          </div>

          {isPerp && funding.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-medium text-gray-300">Funding horaire (7 jours)</h3>
              <FundingChart data={funding} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
