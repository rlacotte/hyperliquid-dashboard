import { useMemo, useState, type ReactNode } from "react";
import { api } from "../api";
import { hl, type Market } from "../hl/client";
import { useHlPoll, useLiveMidsAll } from "../hl/hooks";
import { usePolling } from "../hooks/usePolling";
import { useNow } from "../hooks/useNow";
import { colorPct, fmtAgo, fmtPct, fmtUsdLarge } from "../format";
import { InfoTip } from "../components/InfoTip";
import { AssetDetail } from "../components/AssetDetail";
import {
  annualHolders,
  annualRevenue,
  holdersShare,
  fmtMultiple,
  liveValuation,
  median,
  multiple,
  multipleTone,
  revenueTrend,
  TAB_LABELS,
  TAB_ORDER,
  type Basis,
  type Measure,
  type RevenueRow,
  type RevenueTab,
} from "../revenue";

type SortKey = "symbol" | "rev30" | "trend" | "annual" | "holders" | "mcap" | "fdv" | "mcRev" | "fdvRev";

interface View {
  row: RevenueRow;
  annual: number;
  holders: number | null;
  share: number | null;
  trend: number | null;
  mcap: number | null;
  fdv: number | null;
  mcRev: number | null;
  fdvRev: number | null;
}

const SORT_LABEL: Record<SortKey, string> = {
  symbol: "Token",
  rev30: "Revenus 30 j",
  trend: "Tendance",
  annual: "Revenus annuels",
  holders: "Aux détenteurs",
  mcap: "MC",
  fdv: "FDV",
  mcRev: "MC / revenus",
  fdvRev: "FDV / revenus",
};

/** Les multiples se lisent du plus bas (bon marché) au plus haut ; le reste, du plus grand au plus petit. */
const ASC_BY_DEFAULT: SortKey[] = ["symbol", "mcRev", "fdvRev"];

export function RevenuePage() {
  const data = usePolling(() => api.revenue(), 600_000);
  const perps = useHlPoll(() => hl.perps(""), 120_000);
  const mids = useLiveMidsAll([""]);
  const now = useNow(60_000);

  const [tab, setTab] = useState<RevenueTab | "all">("all");
  const [basis, setBasis] = useState<Basis>("30d");
  const [measure, setMeasure] = useState<Measure>("revenue");
  const [sort, setSort] = useState<SortKey>("annual");
  const [asc, setAsc] = useState(false);
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<Market | null>(null);

  const rows = data.data?.rows ?? [];
  const counts = useMemo(() => {
    const c: Partial<Record<RevenueTab, number>> = {};
    for (const r of rows) c[r.tab] = (c[r.tab] ?? 0) + 1;
    return c;
  }, [rows]);

  const views: View[] = useMemo(
    () =>
      rows.map((row) => {
        const annual = annualRevenue(row, basis);
        const holders = annualHolders(row, basis);
        // Base des multiples : tous les revenus, ou la part reversée aux détenteurs.
        const base = measure === "revenue" ? annual : holders ?? 0;
        const { mcap, fdv } = liveValuation(row, row.listed === "perp" ? mids[row.symbol] : undefined);
        return {
          row,
          annual,
          holders,
          share: holdersShare(row),
          trend: revenueTrend(row),
          mcap,
          fdv,
          mcRev: multiple(mcap, base),
          fdvRev: multiple(fdv, base),
        };
      }),
    [rows, basis, measure, mids]
  );

  const visible = useMemo(() => {
    const query = q.trim().toUpperCase();
    const list = views.filter(
      (v) => (tab === "all" || v.row.tab === tab) && (!query || v.row.symbol.includes(query) || v.row.name.toUpperCase().includes(query))
    );
    const val = (v: View): number | string | null => {
      switch (sort) {
        case "symbol":
          return v.row.symbol;
        case "rev30":
          return v.row.rev_30d;
        case "trend":
          return v.trend;
        case "annual":
          return v.annual;
        case "holders":
          return v.holders;
        case "mcap":
          return v.mcap;
        case "fdv":
          return v.fdv;
        case "mcRev":
          return v.mcRev;
        case "fdvRev":
          return v.fdvRev;
      }
    };
    return list.sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      // Valeurs manquantes toujours en bas, quel que soit le sens.
      if (va === null) return vb === null ? 0 : 1;
      if (vb === null) return -1;
      const d = typeof va === "string" ? va.localeCompare(vb as string) : (va as number) - (vb as number);
      return asc ? d : -d;
    });
  }, [views, tab, q, sort, asc]);

  const summary = useMemo(() => {
    const total30 = visible.reduce((s, v) => s + (measure === "revenue" ? v.row.rev_30d : v.row.hold_30d ?? 0), 0);
    return {
      total30,
      mcRev: median(visible.map((v) => v.mcRev).filter((m): m is number => m !== null)),
      fdvRev: median(visible.map((v) => v.fdvRev).filter((m): m is number => m !== null)),
    };
  }, [visible, measure]);

  const perpBySymbol = useMemo(() => new Map((perps.data ?? []).map((m) => [m.name.toUpperCase(), m])), [perps.data]);

  const toggleSort = (k: SortKey) => {
    if (k === sort) setAsc((a) => !a);
    else {
      setSort(k);
      setAsc(ASC_BY_DEFAULT.includes(k));
    }
  };

  const basisLabel = basis === "30d" ? "30 j annualisés" : "12 mois";
  const per = measure === "revenue" ? "rev." : "dét.";

  return (
    <main className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3 md:overflow-hidden md:p-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="text-lg font-semibold text-white">Revenus des protocoles</h1>
        {data.data && (
          <span className="text-xs text-gray-500">
            {rows.length} tokens cotés sur Hyperliquid · relevé il y a {fmtAgo(data.data.ts, now)}
          </span>
        )}
      </div>

      <details className="max-w-5xl rounded-lg border border-bg-border bg-bg-panel p-3 text-xs leading-relaxed text-gray-400">
        <summary className="cursor-pointer text-gray-300">Ce que mesurent ces chiffres</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>
            <span className="text-gray-300">Revenus</span> (DefiLlama) : la part des frais que garde le protocole — trésorerie et détenteurs du token —
            après rémunération des fournisseurs de liquidité. Pour une L1, ce sont surtout les frais brûlés ; pour une L2, la marge du séquenceur après
            les coûts de publication.
          </li>
          <li>
            <span className="text-gray-300">Aux détenteurs</span> : la part de ces revenus qui revient aux détenteurs du token — rachats, burns,
            distributions aux stakers du token. C'est l'équivalent d'un bénéfice distribué : un multiple calculé dessus se lit comme un PER. « Non
            publié » signifie que DefiLlama ne suit pas ce flux pour ce protocole, pas qu'il est nul.
          </li>
          <li>
            Toutes les activités d'un même token sont additionnées : HYPE cumule le DEX de perps, le spot et les frais de la L1 ; UNI les versions V2 à V4.
          </li>
          <li>
            <span className="text-gray-300">Multiples</span> : capitalisation (MC, offre en circulation) ou valorisation totalement diluée (FDV) divisée
            par les revenus annuels. Bas = bon marché au regard des revenus ; un écart MC/FDV important signale une forte dilution à venir.
          </li>
          <li>
            Base au choix : 30 derniers jours annualisés (réagit vite, bruité) ou 12 derniers mois (lissé, en retard). MC et FDV (CoinGecko) sont
            réajustées au prix Hyperliquid en direct.
          </li>
          <li>Tokens cotés en perp sur le DEX principal, ou en spot pour les protocoles qui tournent sur Hyperliquid.</li>
        </ul>
      </details>

      <div className="no-scrollbar -mx-3 shrink-0 overflow-x-auto px-3 md:mx-0 md:px-0">
        <div className="flex w-max gap-1 rounded-lg border border-bg-border bg-bg-panel p-0.5 text-sm">
          {(["all", ...TAB_ORDER.filter((t) => counts[t])] as (RevenueTab | "all")[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`whitespace-nowrap rounded-md px-3 py-1 ${tab === t ? "bg-blue-600 text-white" : "text-gray-400 hover:text-white"}`}
            >
              {t === "all" ? "Tous" : TAB_LABELS[t]}
              <span className={`ml-1.5 text-xs ${tab === t ? "text-blue-200" : "text-gray-600"}`}>{t === "all" ? rows.length : counts[t]}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="flex rounded-md border border-bg-border bg-bg-panel p-0.5">
          {(
            [
              ["30d", "30 j annualisés"],
              ["1y", "12 mois"],
            ] as [Basis, string][]
          ).map(([b, label]) => (
            <button
              key={b}
              onClick={() => setBasis(b)}
              className={`rounded px-2 py-0.5 ${basis === b ? "bg-bg-hover text-white" : "text-gray-500 hover:text-gray-200"}`}
            >
              {label}
            </button>
          ))}
        </span>
        <InfoTip text="Revenus annuels servant aux multiples : les 30 derniers jours × 365/30, ou la somme des 12 derniers mois." />
        <span className="ml-1 text-gray-500">Multiples sur</span>
        <span className="flex rounded-md border border-bg-border bg-bg-panel p-0.5">
          {(
            [
              ["revenue", "revenus"],
              ["holders", "revenus aux détenteurs"],
            ] as [Measure, string][]
          ).map(([m, label]) => (
            <button
              key={m}
              onClick={() => setMeasure(m)}
              className={`rounded px-2 py-0.5 ${measure === m ? "bg-bg-hover text-white" : "text-gray-500 hover:text-gray-200"}`}
            >
              {label}
            </button>
          ))}
        </span>
        <select
          value={sort}
          onChange={(e) => {
            const k = e.target.value as SortKey;
            setSort(k);
            setAsc(ASC_BY_DEFAULT.includes(k));
          }}
          aria-label="Trier par"
          className="rounded-md border border-bg-border bg-bg-panel px-2 py-1 text-gray-300 sm:hidden"
        >
          {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => (
            <option key={k} value={k}>
              Tri : {SORT_LABEL[k]}
            </option>
          ))}
        </select>
        {visible.length > 0 && (
          <span className="text-gray-500">
            {measure === "revenue" ? "Revenus" : "Reversé aux détenteurs"} 30 j cumulés{" "}
            <span className="text-gray-300">{fmtUsdLarge(summary.total30)}</span> · médiane MC/{per}{" "}
            <span className="text-gray-300">{fmtMultiple(summary.mcRev)}</span> · FDV/{per}{" "}
            <span className="text-gray-300">{fmtMultiple(summary.fdvRev)}</span>
          </span>
        )}
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filtrer…"
          className="ml-auto w-28 rounded-md border border-bg-border bg-bg-panel px-3 py-1.5 text-sm text-gray-200 outline-none focus:border-blue-500 sm:w-36"
        />
      </div>

      {data.error && !data.data ? (
        <p className="text-sm text-gray-400">
          {data.error.includes("503") ? "Revenus pas encore collectés : ils apparaîtront au prochain cycle de collecte (quelques minutes)." : `Erreur : ${data.error}`}
        </p>
      ) : !data.data ? (
        <p className="text-sm text-gray-500">Chargement…</p>
      ) : (
        <div className="shrink-0 overflow-auto rounded-lg border border-bg-border md:min-h-0 md:flex-1 md:shrink">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-bg-panel text-xs text-gray-400">
              <tr>
                <Th k="symbol" sort={sort} asc={asc} onSort={toggleSort} align="left">
                  Token
                </Th>
                <Th k={null} align="left" secondary>
                  Catégorie
                </Th>
                <Th k="rev30" sort={sort} asc={asc} onSort={toggleSort} secondary>
                  Revenus 30 j
                </Th>
                <Th k="trend" sort={sort} asc={asc} onSort={toggleSort} secondary help="Revenus des 30 derniers jours contre les 30 précédents.">
                  Tendance
                </Th>
                <Th k="annual" sort={sort} asc={asc} onSort={toggleSort} help={`Base des multiples : ${basisLabel}.`}>
                  Rev. annuels
                </Th>
                <Th
                  k="holders"
                  sort={sort}
                  asc={asc}
                  onSort={toggleSort}
                  secondary
                  help={`Revenus reversés aux détenteurs du token (rachats, burns, distributions), ${basisLabel}. En dessous : la part des revenus que cela représente.`}
                >
                  Aux détenteurs
                </Th>
                <Th k="mcap" sort={sort} asc={asc} onSort={toggleSort} secondary help="Capitalisation : offre en circulation × prix.">
                  MC
                </Th>
                <Th k="fdv" sort={sort} asc={asc} onSort={toggleSort} secondary help="Valorisation totalement diluée : offre maximale × prix.">
                  FDV
                </Th>
                <Th
                  k="mcRev"
                  sort={sort}
                  asc={asc}
                  onSort={toggleSort}
                  help={measure === "revenue" ? "Capitalisation / revenus annuels." : "Capitalisation / revenus annuels reversés aux détenteurs (équivalent d'un PER)."}
                  secondary
                >
                  MC / {per}
                </Th>
                <Th
                  k="fdvRev"
                  sort={sort}
                  asc={asc}
                  onSort={toggleSort}
                  help={measure === "revenue" ? "FDV / revenus annuels." : "FDV / revenus annuels reversés aux détenteurs."}
                  last
                  secondary
                >
                  FDV / {per}
                </Th>
                {/* Téléphone : les deux multiples dans une seule colonne. */}
                <th className="px-2 py-2 text-right font-medium sm:hidden">
                  MC · FDV
                  <br />/ {per}
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((v) => {
                const market = v.row.listed === "perp" ? perpBySymbol.get(v.row.symbol) ?? perpBySymbol.get(`K${v.row.symbol}`) : undefined;
                return (
                  <tr
                    key={v.row.gecko_id}
                    onClick={() => market && setSelected(market)}
                    className={`border-t border-bg-border hover:bg-bg-hover ${market ? "cursor-pointer" : ""}`}
                  >
                    <td className="px-2 py-1.5 sm:px-3">
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium text-white">{v.row.symbol}</span>
                        {v.row.listed === "spot" && (
                          <span className="rounded bg-sky-500/15 px-1 py-px text-[10px] font-medium uppercase text-sky-300" title="Coté en spot sur Hyperliquid">
                            spot
                          </span>
                        )}
                      </div>
                      <div
                        className="max-w-[8rem] truncate text-[11px] text-gray-500 sm:max-w-[14rem]"
                        title={v.row.sources.map((s) => `${s.name} (${s.kind === "chain" ? "chaîne" : s.category ?? "?"}) : ${fmtUsdLarge(s.rev_30d)} / 30 j`).join("\n")}
                      >
                        {v.row.sources.length > 1 ? v.row.sources.map((s) => s.name).join(" + ") : v.row.name}
                      </div>
                    </td>
                    <td className="hidden px-3 py-1.5 text-xs text-gray-400 sm:table-cell">{v.row.category ?? "—"}</td>
                    <Td secondary>{fmtUsdLarge(v.row.rev_30d)}</Td>
                    <Td secondary className={v.trend === null ? "text-gray-600" : colorPct(v.trend)}>
                      {v.trend === null ? "—" : fmtPct(v.trend).replace(/\.\d+%/, "%")}
                    </Td>
                    <Td className="font-semibold text-gray-100">{v.annual > 0 ? fmtUsdLarge(v.annual) : "—"}</Td>
                    <td className="hidden whitespace-nowrap px-3 py-1.5 text-right tabular-nums sm:table-cell">
                      {v.holders === null ? (
                        <span className="text-gray-600" title="DefiLlama ne publie pas ce flux pour ce protocole : inconnu, pas forcément nul.">
                          non publié
                        </span>
                      ) : (
                        <>
                          <div className={v.holders > 0 ? "text-gray-200" : "text-gray-500"}>{v.holders > 0 ? fmtUsdLarge(v.holders) : "0 $"}</div>
                          {v.share !== null && <div className="text-[11px] text-gray-500">{Math.round(v.share * 100)} % des revenus</div>}
                        </>
                      )}
                    </td>
                    <Td secondary>{v.mcap === null ? "—" : fmtUsdLarge(v.mcap)}</Td>
                    <Td secondary>{v.fdv === null ? "—" : fmtUsdLarge(v.fdv)}</Td>
                    <Td secondary className={`font-semibold ${multipleTone(v.mcRev)}`}>{fmtMultiple(v.mcRev)}</Td>
                    <Td secondary className={multipleTone(v.fdvRev)}>{fmtMultiple(v.fdvRev)}</Td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums sm:hidden">
                      <div className={`font-semibold ${multipleTone(v.mcRev)}`}>{fmtMultiple(v.mcRev)}</div>
                      <div className={`text-[11px] ${multipleTone(v.fdvRev)}`}>{fmtMultiple(v.fdvRev)}</div>
                    </td>
                  </tr>
                );
              })}
              {visible.length === 0 && (
                <tr>
                  <td colSpan={11} className="py-10 text-center text-gray-500">
                    Aucun token ne correspond.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {selected && <DetailWithLivePrice market={selected} onClose={() => setSelected(null)} />}
    </main>
  );
}

function DetailWithLivePrice({ market, onClose }: { market: Market; onClose: () => void }) {
  const mids = useLiveMidsAll([market.dex]);
  return <AssetDetail market={market} livePx={mids[market.id]} confluence={undefined} onClose={onClose} />;
}

function Th({
  children,
  k,
  sort,
  asc,
  onSort,
  align = "right",
  help,
  last,
  secondary,
}: {
  children: ReactNode;
  k: SortKey | null;
  sort?: SortKey;
  asc?: boolean;
  onSort?: (k: SortKey) => void;
  align?: "left" | "right";
  help?: string;
  last?: boolean;
  /** Masquée sous 640 px. */
  secondary?: boolean;
}) {
  return (
    <th
      className={`whitespace-nowrap px-2 py-2 font-medium sm:px-3 ${align === "left" ? "text-left" : "text-right"} ${
        secondary ? "hidden sm:table-cell" : ""
      }`}
    >
      {k && onSort ? (
        <button onClick={() => onSort(k)} className={sort === k ? "text-white" : "hover:text-white"}>
          {children}
          {sort === k && <span className="ml-1 text-[10px]">{asc ? "▲" : "▼"}</span>}
        </button>
      ) : (
        children
      )}
      {help && <InfoTip text={help} align={last ? "right" : "center"} />}
    </th>
  );
}

function Td({ children, className = "text-gray-300", secondary }: { children: ReactNode; className?: string; secondary?: boolean }) {
  return (
    <td className={`whitespace-nowrap px-2 py-1.5 text-right tabular-nums sm:px-3 ${className} ${secondary ? "hidden sm:table-cell" : ""}`}>
      {children}
    </td>
  );
}
