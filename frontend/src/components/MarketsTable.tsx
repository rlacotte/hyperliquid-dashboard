import { useMemo, useState, type ReactNode } from "react";
import type { Market, MarketKind } from "../hl/client";
import type { ConfluenceScore } from "../types";
import {
  colorPct,
  colorScore,
  directionArrow,
  fmtApr,
  fmtFunding,
  fmtPct,
  fmtScore,
  fmtUsd,
  fundingApr,
} from "../format";
import { LivePrice } from "./LivePrice";
import { InfoTip } from "./InfoTip";

interface Props {
  markets: Market[];
  /** Prix en direct (websocket), indexés par id de marché. */
  mids: Record<string, number>;
  confluence: Map<string, ConfluenceScore>;
  oiCaps: Set<string>;
  selectedId: string | null;
  onSelect: (m: Market) => void;
}

type SortDir = "asc" | "desc";

interface Ctx {
  px: (m: Market) => number;
  chg: (m: Market) => number;
  score: (m: Market) => ConfluenceScore | undefined;
  atCap: (m: Market) => boolean;
}

interface Col {
  id: string;
  label: string;
  align: "left" | "right";
  help?: string;
  kinds: MarketKind[];
  /** Masquée sous 640 px : sur téléphone, on garde marché, prix, 24h, régime. */
  secondary?: boolean;
  sortValue: (m: Market, c: Ctx) => number | string;
  render: (m: Market, c: Ctx) => ReactNode;
}

const ALL: MarketKind[] = ["perp", "hip3", "spot"];
const PERPS: MarketKind[] = ["perp", "hip3"];

const COLS: Col[] = [
  {
    id: "name",
    label: "Marché",
    align: "left",
    kinds: ALL,
    sortValue: (m) => m.name,
    render: (m, c) => (
      <span className="flex items-center gap-1.5">
        <span className="font-medium text-white">{m.name}</span>
        {m.kind === "hip3" && (
          <span className="rounded bg-purple-500/15 px-1 py-px text-[10px] font-medium uppercase text-purple-300">
            {m.dex}
          </span>
        )}
        {m.maxLeverage && <span className="hidden text-[10px] text-gray-600 sm:inline">{m.maxLeverage}×</span>}
        {c.atCap(m) && (
          <span
            className="rounded bg-amber-500/15 px-1 py-px text-[10px] font-semibold text-amber-300"
            title="Open interest au plafond : impossible d'ouvrir de nouvelles positions, seulement d'en réduire."
          >
            OI CAP
          </span>
        )}
      </span>
    ),
  },
  {
    id: "px",
    label: "Prix",
    align: "right",
    help: "Prix mid en direct (websocket Hyperliquid), mis à jour à chaque tick.",
    kinds: ALL,
    sortValue: (m, c) => c.px(m),
    render: (m, c) => <LivePrice value={c.px(m)} className="text-gray-100" />,
  },
  {
    id: "chg",
    label: "24h",
    align: "right",
    help: "Variation entre le prix actuel et celui d'il y a 24 h, recalculée en continu.",
    kinds: ALL,
    sortValue: (m, c) => c.chg(m),
    render: (m, c) => <span className={`tabular-nums ${colorPct(c.chg(m))}`}>{fmtPct(c.chg(m))}</span>,
  },
  {
    id: "score",
    label: "Régime",
    align: "right",
    help: "Score de confluence (−10 à +10) issu du croisement prix × open interest, amplifié par le volume et pondéré par le funding. 0 = aucun régime identifiable.",
    // HIP-3 compris : le moteur de régimes tourne aussi sur ces marchés.
    kinds: ["perp", "hip3"],
    sortValue: (m, c) => Math.abs(c.score(m)?.score ?? 0),
    render: (m, c) => {
      const s = c.score(m);
      if (!s || s.score === 0) return <span className="text-gray-600">—</span>;
      return (
        <span className={`tabular-nums ${colorScore(s.score)}`} title={s.regime_label}>
          {directionArrow(s.direction)} {fmtScore(s.score)}
        </span>
      );
    },
  },
  {
    id: "funding",
    label: "Funding",
    align: "right",
    help: "Taux payé chaque heure par les longs aux shorts (si positif) ou l'inverse. En dessous : le même taux annualisé (APR), comparable avec Binance ou Bybit qui paient toutes les 4 ou 8 h.",
    kinds: PERPS,
    secondary: true,
    sortValue: (m) => m.funding ?? 0,
    render: (m) =>
      m.funding === null ? (
        "—"
      ) : (
        <span className="flex flex-col items-end leading-tight">
          <span className={`tabular-nums ${colorPct(m.funding)}`}>{fmtFunding(m.funding)}</span>
          <span className="text-[10px] tabular-nums text-gray-500">{fmtApr(fundingApr(m.funding))} /an</span>
        </span>
      ),
  },
  {
    id: "oi",
    label: "Open interest",
    align: "right",
    help: "Valeur notionnelle de toutes les positions ouvertes, en USD.",
    kinds: PERPS,
    secondary: true,
    sortValue: (m) => m.openInterestUsd ?? 0,
    render: (m) => <span className="tabular-nums text-gray-300">{m.openInterestUsd === null ? "—" : fmtUsd(m.openInterestUsd)}</span>,
  },
  {
    id: "vol",
    label: "Volume 24h",
    align: "right",
    help: "Volume échangé sur les dernières 24 h, en USD.",
    kinds: ALL,
    secondary: true,
    sortValue: (m) => m.volume24h,
    render: (m) => <span className="tabular-nums text-gray-300">{fmtUsd(m.volume24h)}</span>,
  },
];

const TABS: { kind: MarketKind; label: string; help: string }[] = [
  { kind: "perp", label: "Crypto", help: "Perpétuels crypto du DEX principal Hyperliquid." },
  {
    kind: "hip3",
    label: "HIP-3",
    help: "Perpétuels déployés par des tiers (HIP-3) : actions, indices, matières premières, devises — négociables 24h/24.",
  },
  { kind: "spot", label: "Spot", help: "Paires au comptant du carnet spot Hyperliquid." },
];

/** Seuil sous lequel un marché est considéré inactif et masqué par défaut. */
const ACTIVE_MIN_USD = 10_000;
const isActive = (m: Market) =>
  !m.isDelisted && (m.volume24h >= ACTIVE_MIN_USD || (m.openInterestUsd ?? 0) >= ACTIVE_MIN_USD);

export function MarketsTable({ markets, mids, confluence, oiCaps, selectedId, onSelect }: Props) {
  const [tab, setTab] = useState<MarketKind>("perp");
  const [dex, setDex] = useState<string>("");
  const [filter, setFilter] = useState("");
  const [sortId, setSortId] = useState("vol");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [showInactive, setShowInactive] = useState(false);

  const ctx: Ctx = useMemo(
    () => ({
      px: (m) => mids[m.id] ?? m.markPx,
      chg: (m) => {
        const px = mids[m.id] ?? m.markPx;
        return m.prevDayPx > 0 ? (px - m.prevDayPx) / m.prevDayPx : 0;
      },
      score: (m) => (m.kind === "spot" ? undefined : confluence.get(m.id)),
      atCap: (m) => oiCaps.has(m.id),
    }),
    [mids, confluence, oiCaps]
  );

  const visible = useMemo(() => markets.filter((m) => showInactive || isActive(m)), [markets, showInactive]);

  const counts = useMemo(() => {
    const c: Record<MarketKind, number> = { perp: 0, hip3: 0, spot: 0 };
    for (const m of visible) c[m.kind] += 1;
    return c;
  }, [visible]);

  const dexes = useMemo(() => {
    const vol = new Map<string, number>();
    for (const m of visible) if (m.kind === "hip3") vol.set(m.dex, (vol.get(m.dex) ?? 0) + m.volume24h);
    return [...vol.entries()].sort((a, b) => b[1] - a[1]).map(([d]) => d);
  }, [visible]);

  const cols = COLS.filter((c) => c.kinds.includes(tab));
  const sortCol = cols.find((c) => c.id === sortId) ?? cols.find((c) => c.id === "vol")!;

  const rows = useMemo(() => {
    const q = filter.trim().toUpperCase();
    const list = visible.filter(
      (m) => m.kind === tab && (tab !== "hip3" || !dex || m.dex === dex) && (!q || m.name.toUpperCase().includes(q))
    );
    list.sort((a, b) => {
      const va = sortCol.sortValue(a, ctx);
      const vb = sortCol.sortValue(b, ctx);
      const d = typeof va === "string" ? va.localeCompare(vb as string) : (va as number) - (vb as number);
      return sortDir === "asc" ? d : -d;
    });
    return list;
  }, [visible, tab, dex, filter, sortCol, sortDir, ctx]);

  const toggleSort = (id: string) => {
    if (id === sortId) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortId(id);
      setSortDir(id === "name" ? "asc" : "desc");
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-bg-border bg-bg-panel p-0.5">
          {TABS.map((t) => (
            <button
              key={t.kind}
              onClick={() => {
                setTab(t.kind);
                setDex("");
              }}
              title={t.help}
              className={`rounded-md px-3 py-1 text-sm transition-colors ${
                tab === t.kind ? "bg-blue-600 text-white" : "text-gray-400 hover:text-white"
              }`}
            >
              {t.label}
              <span className={`ml-1.5 text-xs ${tab === t.kind ? "text-blue-200" : "text-gray-600"}`}>{counts[t.kind]}</span>
            </button>
          ))}
        </div>

        {tab === "hip3" && dexes.length > 1 && (
          <div className="flex flex-wrap gap-1">
            {["", ...dexes].map((d) => (
              <button
                key={d || "all"}
                onClick={() => setDex(d)}
                className={`rounded px-2 py-0.5 text-xs uppercase ${
                  dex === d ? "bg-purple-500/25 text-purple-200" : "bg-bg-panel text-gray-500 hover:text-gray-200"
                }`}
              >
                {d || "tous"}
              </button>
            ))}
          </div>
        )}

        <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-xs text-gray-500">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
            className="accent-blue-500"
          />
          Inactifs
        </label>
        {/* Mobile : les colonnes de tri masquées restent accessibles ici. */}
        <select
          value={sortCol.id}
          onChange={(e) => {
            setSortId(e.target.value);
            setSortDir(e.target.value === "name" ? "asc" : "desc");
          }}
          aria-label="Trier par"
          className="rounded-md border border-bg-border bg-bg-panel px-2 py-1.5 text-sm text-gray-300 sm:hidden"
        >
          {cols.map((c) => (
            <option key={c.id} value={c.id}>
              Tri : {c.label}
            </option>
          ))}
        </select>
        <input
          type="text"
          placeholder="Filtrer…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="w-28 rounded-md border border-bg-border bg-bg-panel px-3 py-1.5 text-sm sm:w-36 text-gray-200 outline-none focus:border-blue-500"
        />
      </div>

      <div className="flex-1 overflow-auto rounded-lg border border-bg-border">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10 bg-bg-panel">
            <tr>
              {cols.map((col, i) => (
                <th
                  key={col.id}
                  className={`select-none whitespace-nowrap px-2 py-2.5 font-medium text-gray-400 sm:px-3 ${
                    col.align === "right" ? "text-right" : "text-left"
                  } ${col.secondary ? "hidden sm:table-cell" : ""}`}
                >
                  <button onClick={() => toggleSort(col.id)} className="hover:text-white">
                    {col.label}
                    {sortId === col.id && <span className="ml-1 text-[10px]">{sortDir === "asc" ? "▲" : "▼"}</span>}
                  </button>
                  {col.help && <InfoTip text={col.help} align={i === cols.length - 1 ? "right" : i === 0 ? "left" : "center"} />}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr
                key={m.id}
                onClick={() => onSelect(m)}
                className={`cursor-pointer border-t border-bg-border transition-colors hover:bg-bg-hover ${
                  selectedId === m.id ? "bg-bg-hover" : ""
                }`}
              >
                {cols.map((col) => (
                  <td
                    key={col.id}
                    className={`whitespace-nowrap px-2 py-1.5 sm:px-3 ${col.align === "right" ? "text-right" : "text-left"} ${
                      col.secondary ? "hidden sm:table-cell" : ""
                    }`}
                  >
                    {col.render(m, ctx)}
                  </td>
                ))}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={cols.length} className="px-3 py-10 text-center text-gray-500">
                  Aucun marché ne correspond.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
