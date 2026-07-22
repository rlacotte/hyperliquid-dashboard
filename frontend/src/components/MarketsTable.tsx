import { useMemo, useState } from "react";
import type { AssetMarket, ConfluenceScore } from "../types";
import { colorPct, colorScore, directionArrow, fmtFunding, fmtPct, fmtPrice, fmtScore, fmtUsd } from "../format";

type SortKey = "coin" | "mark_px" | "change_24h_pct" | "score" | "funding" | "open_interest_usd" | "day_ntl_vlm";
type SortDir = "asc" | "desc";

interface Props {
  assets: AssetMarket[];
  confluenceScores: ConfluenceScore[];
  onSelectCoin: (coin: string) => void;
  selectedCoin: string | null;
}

const COLS: { key: SortKey; label: string; align: "left" | "right" }[] = [
  { key: "coin", label: "Coin", align: "left" },
  { key: "mark_px", label: "Prix", align: "right" },
  { key: "change_24h_pct", label: "% 24h", align: "right" },
  { key: "score", label: "Score", align: "right" },
  { key: "funding", label: "Funding", align: "right" },
  { key: "open_interest_usd", label: "Open Interest", align: "right" },
  { key: "day_ntl_vlm", label: "Vol 24h", align: "right" },
];

export function MarketsTable({ assets, confluenceScores, onSelectCoin, selectedCoin }: Props) {
  // Tri par défaut sur le score (signaux forts en haut)
  const [sortKey, setSortKey] = useState<SortKey>("score");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [filter, setFilter] = useState("");

  // Index des scores par coin pour lookup O(1)
  const scoreByCoin = useMemo(() => {
    const m = new Map<string, ConfluenceScore>();
    for (const s of confluenceScores) m.set(s.coin, s);
    return m;
  }, [confluenceScores]);

  const sorted = useMemo(() => {
    let list = assets;
    if (filter) {
      const q = filter.toUpperCase();
      list = list.filter((a) => a.coin.includes(q));
    }
    const sortedList = [...list].sort((a, b) => {
      if (sortKey === "score") {
        // Score vient du lookup confluence, pas de l'asset lui-même
        const sa = Math.abs(scoreByCoin.get(a.coin)?.score ?? 0);
        const sb = Math.abs(scoreByCoin.get(b.coin)?.score ?? 0);
        return sa - sb;
      }
      const av = a[sortKey];
      const bv = b[sortKey];
      if (typeof av === "string" && typeof bv === "string") {
        return av.localeCompare(bv);
      }
      return (av as number) - (bv as number);
    });
    return sortDir === "asc" ? sortedList : sortedList.reverse();
  }, [assets, sortKey, sortDir, filter, scoreByCoin]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex items-center gap-3">
        <h2 className="text-lg font-semibold text-white">Marchés Perp</h2>
        <span className="text-sm text-gray-500">({sorted.length} actifs)</span>
        <input
          type="text"
          placeholder="Filtrer..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="ml-auto rounded-md border border-bg-border bg-bg-panel px-3 py-1.5 text-sm text-gray-200 outline-none focus:border-blue-500"
        />
      </div>
      <div className="flex-1 overflow-auto rounded-lg border border-bg-border">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10 bg-bg-panel">
            <tr>
              {COLS.map((col) => (
                <th
                  key={col.key}
                  onClick={() => toggleSort(col.key)}
                  className={`cursor-pointer select-none px-4 py-2.5 font-medium text-gray-400 hover:text-white ${
                    col.align === "right" ? "text-right" : "text-left"
                  }`}
                >
                  {col.label}
                  {sortKey === col.key && (
                    <span className="ml-1">{sortDir === "asc" ? "▲" : "▼"}</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((a) => {
              const conf = scoreByCoin.get(a.coin);
              const score = conf?.score ?? 0;
              const dir = conf?.direction;
              return (
                <tr
                  key={a.coin}
                  onClick={() => onSelectCoin(a.coin)}
                  className={`cursor-pointer border-t border-bg-border transition-colors hover:bg-bg-hover ${
                    selectedCoin === a.coin ? "bg-bg-hover" : ""
                  }`}
                >
                  <td className="px-4 py-2 font-medium text-white">{a.coin}</td>
                  <td className="px-4 py-2 text-right text-gray-200">
                    {fmtPrice(a.mark_px)}
                  </td>
                  <td className={`px-4 py-2 text-right font-mono ${colorPct(a.change_24h_pct)}`}>
                    {fmtPct(a.change_24h_pct)}
                  </td>
                  <td className={`px-4 py-2 text-right font-mono ${colorScore(score)}`}>
                    {score !== 0 ? `${directionArrow(dir)} ${fmtScore(score)}` : "—"}
                  </td>
                  <td className={`px-4 py-2 text-right font-mono ${colorPct(a.funding)}`}>
                    {fmtFunding(a.funding)}
                  </td>
                  <td className="px-4 py-2 text-right text-gray-300">
                    {fmtUsd(a.open_interest_usd)}
                  </td>
                  <td className="px-4 py-2 text-right text-gray-300">
                    {fmtUsd(a.day_ntl_vlm)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
