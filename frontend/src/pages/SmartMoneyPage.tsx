import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "../api";
import { hl, type ClearinghouseState } from "../hl/client";
import { useLiveMidsAll } from "../hl/hooks";
import { usePolling } from "../hooks/usePolling";
import { href } from "../router";
import { shortAddr } from "../wallet";
import {
  aggregateBias,
  edgeBp,
  extractPositions,
  liquidationLadder,
  mapLimit,
  PROFILES,
  type LeaderRow,
  type Profile,
  type TrackedPosition,
} from "../smartmoney";
import { colorPct, fmtPct, fmtPrice, fmtUsd, fmtUsdSigned } from "../format";
import { InfoTip } from "../components/InfoTip";

type Tab = "ranking" | "positioning" | "liquidations";
type Win = "week" | "month" | "all";

/** Cohorte suivie pour le positionnement : réguliers et directionnels, gros comptes. */
const COHORT_SIZE = 100;
const COHORT_MIN_VALUE = 500_000;
const COHORT_PROFILES: Profile[] = ["consistent", "directional"];

export function SmartMoneyPage() {
  const [tab, setTab] = useState<Tab>("ranking");
  const lb = usePolling(() => api.leaderboard(), 300_000);
  const rows = useMemo(() => lb.data?.rows ?? [], [lb.data]);

  const cohort = useMemo(
    () =>
      rows
        .filter((r) => COHORT_PROFILES.includes(r.pr) && r.av >= COHORT_MIN_VALUE)
        .sort((a, b) => b.pm - a.pm)
        .slice(0, COHORT_SIZE),
    [rows]
  );

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-auto p-3 md:overflow-hidden md:p-4">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold text-white">Smart money</h1>
        <div className="flex rounded-lg border border-bg-border bg-bg-panel p-0.5">
          {(
            [
              ["ranking", "Classement"],
              ["positioning", "Positionnement"],
              ["liquidations", "Liquidations"],
            ] as [Tab, string][]
          ).map(([t, label]) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded-md px-3 py-1 text-sm ${tab === t ? "bg-blue-600 text-white" : "text-gray-400 hover:text-white"}`}
            >
              {label}
            </button>
          ))}
        </div>
        {lb.data && (
          <span className="text-xs text-gray-500">
            {lb.data.total.toLocaleString("fr-FR")} comptes analysés · distillé {new Date(lb.data.ts).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}
          </span>
        )}
      </div>

      {lb.error && !lb.data ? (
        <Centered className="text-gray-400">
          Leaderboard pas encore disponible : il est distillé côté serveur au prochain cycle de collecte.
        </Centered>
      ) : !lb.data ? (
        <Centered>Chargement…</Centered>
      ) : tab === "ranking" ? (
        <RankingTab rows={rows} snapshots={lb.data.snapshots} />
      ) : (
        <CohortTabs tab={tab} cohort={cohort} />
      )}
    </main>
  );
}

// --- Classement ------------------------------------------------------------------
const WIN_FIELDS: Record<Win, { pnl: keyof LeaderRow; roi: keyof LeaderRow; label: string }> = {
  week: { pnl: "pw", roi: "rw", label: "7 j" },
  month: { pnl: "pm", roi: "rm", label: "30 j" },
  all: { pnl: "pa", roi: "ra", label: "Historique" },
};

type SortKey = "pnl" | "roi" | "edge" | "av";

function RankingTab({ rows, snapshots }: { rows: LeaderRow[]; snapshots: { days: number; since: string | null } }) {
  const [profiles, setProfiles] = useState<Set<Profile>>(new Set(["consistent", "directional"]));
  const [win, setWin] = useState<Win>("month");
  const [sort, setSort] = useState<SortKey>("pnl");
  const [limit, setLimit] = useState(100);
  const [showMethod, setShowMethod] = useState(false);

  const counts = useMemo(() => {
    const c = Object.fromEntries(Object.keys(PROFILES).map((p) => [p, 0])) as Record<Profile, number>;
    for (const r of rows) c[r.pr] += 1;
    return c;
  }, [rows]);

  const f = WIN_FIELDS[win];
  const list = useMemo(() => {
    const filtered = rows.filter((r) => profiles.has(r.pr));
    const val = (r: LeaderRow): number => {
      if (sort === "pnl") return r[f.pnl] as number;
      if (sort === "roi") return r[f.roi] as number;
      if (sort === "edge") return edgeBp(r) ?? -Infinity;
      return r.av;
    };
    return filtered.sort((a, b) => val(b) - val(a));
  }, [rows, profiles, sort, f]);

  const toggle = (p: Profile) =>
    setProfiles((s) => {
      const n = new Set(s);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });

  return (
    <div className="flex flex-col md:min-h-0 md:flex-1">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        {(Object.keys(PROFILES) as Profile[]).map((p) => (
          <button
            key={p}
            onClick={() => toggle(p)}
            title={PROFILES[p].help}
            className={`rounded-md border px-2 py-1 transition-colors ${
              profiles.has(p) ? `border-transparent ${PROFILES[p].tone}` : "border-bg-border text-gray-600 hover:text-gray-300"
            }`}
          >
            {PROFILES[p].label} <span className="opacity-60">{counts[p]}</span>
          </button>
        ))}
        <button onClick={() => setShowMethod((s) => !s)} className="ml-1 text-gray-500 underline-offset-2 hover:text-gray-300 hover:underline">
          {showMethod ? "Masquer la méthode" : "Comment sont classés les traders ?"}
        </button>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
          aria-label="Trier par"
          className="rounded border border-bg-border bg-bg-panel px-1.5 py-1 text-gray-300 sm:hidden"
        >
          <option value="pnl">Tri : PnL</option>
          <option value="roi">Tri : ROI</option>
          <option value="av">Tri : valeur</option>
          <option value="edge">Tri : edge</option>
        </select>
        <div className="ml-auto flex items-center gap-1">
          {(Object.keys(WIN_FIELDS) as Win[]).map((w) => (
            <button key={w} onClick={() => setWin(w)} className={`rounded px-2 py-0.5 ${win === w ? "bg-blue-600 text-white" : "text-gray-500 hover:text-white"}`}>
              {WIN_FIELDS[w].label}
            </button>
          ))}
        </div>
      </div>

      {showMethod && (
        <div className="mb-3 rounded-lg border border-bg-border bg-bg-panel p-3 text-xs leading-relaxed text-gray-400">
          <p className="mb-1.5 text-gray-200">Un classement par PnL brut mélange des comptes sans rapport. Chaque compte reçoit donc un profil, par règles explicites :</p>
          <ul className="space-y-1">
            {(Object.keys(PROFILES) as Profile[]).map((p) => (
              <li key={p}>
                <span className={`mr-1.5 rounded px-1.5 py-px ${PROFILES[p].tone}`}>{PROFILES[p].label}</span>
                {PROFILES[p].help}
              </li>
            ))}
          </ul>
          <p className="mt-2">
            L'<span className="text-gray-200">edge</span> mesure le PnL par dollar échangé sur 30 jours, en points de base : un PnL énorme sur un volume
            énorme peut ne représenter qu'une marge infime.
          </p>
          <p className="mt-2">
            <span className="text-gray-200">Étude de persistance</span> (un top trader le reste-t-il le mois suivant ?) : une photo du classement est prise
            chaque jour depuis le {snapshots.since ?? "premier cycle"} — {snapshots.days} jour{snapshots.days > 1 ? "s" : ""} accumulé
            {snapshots.days > 1 ? "s" : ""}. Les premiers résultats seront publiables après 60 jours (30 j de classement + 30 j d'observation).
          </p>
          <p className="mt-2 text-gray-500">
            Valeur du compte selon le leaderboard Hyperliquid : elle peut agréger des sous-comptes et différer de la marge visible dans l'explorateur.
          </p>
        </div>
      )}

      <div className="overflow-auto rounded-lg border border-bg-border md:min-h-0 md:flex-1">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10 bg-bg-panel text-xs text-gray-400">
            <tr>
              <th className="hidden sm:table-cell px-3 py-2 text-right font-medium">#</th>
              <th className="px-3 py-2 text-left font-medium">Trader</th>
              <th className="hidden sm:table-cell px-3 py-2 text-left font-medium">Profil</th>
              <SortTh secondary active={sort === "av"} onClick={() => setSort("av")} help="Valeur du compte selon le leaderboard Hyperliquid.">
                Valeur
              </SortTh>
              <SortTh active={sort === "pnl"} onClick={() => setSort("pnl")}>
                PnL {f.label}
              </SortTh>
              <SortTh active={sort === "roi"} onClick={() => setSort("roi")}>
                ROI {f.label}
              </SortTh>
              <th className="hidden sm:table-cell px-3 py-2 text-right font-medium">Volume 30 j</th>
              <SortTh secondary active={sort === "edge"} onClick={() => setSort("edge")} help="PnL 30 j par dollar échangé, en points de base.">
                Edge
              </SortTh>
              <th className="hidden px-3 py-2 text-center font-medium sm:table-cell">
                Régularité
                <InfoTip text="Signe du PnL sur 7 j, 30 j et tout l'historique. Trois verts : gagnant sur toutes les fenêtres." align="right" />
              </th>
            </tr>
          </thead>
          <tbody>
            {list.slice(0, limit).map((r, i) => {
              const pnl = r[f.pnl] as number;
              const roi = r[f.roi] as number;
              const edge = edgeBp(r);
              return (
                <tr key={r.a} className="border-t border-bg-border hover:bg-bg-hover">
                  <td className="hidden sm:table-cell px-3 py-1.5 text-right text-xs tabular-nums text-gray-600">{i + 1}</td>
                  <td className="px-3 py-1.5">
                    <a href={href("wallet", r.a)} className="text-blue-300 hover:text-blue-200 hover:underline">
                      {r.n ? <span className="font-medium">{r.n}</span> : <span className="font-mono text-xs">{shortAddr(r.a)}</span>}
                    </a>
                  </td>
                  <td className="hidden sm:table-cell px-3 py-1.5">
                    <span className={`rounded px-1.5 py-px text-[11px] ${PROFILES[r.pr].tone}`} title={PROFILES[r.pr].help}>
                      {PROFILES[r.pr].label}
                    </span>
                  </td>
                  <td className="hidden sm:table-cell px-3 py-1.5 text-right tabular-nums text-gray-300">{fmtUsd(r.av)}</td>
                  <td className={`px-3 py-1.5 text-right font-semibold tabular-nums ${colorPct(pnl)}`}>{fmtUsdSigned(pnl)}</td>
                  <td className={`px-3 py-1.5 text-right tabular-nums ${colorPct(roi)}`}>{fmtPct(roi)}</td>
                  <td className="hidden sm:table-cell px-3 py-1.5 text-right tabular-nums text-gray-500">{fmtUsd(r.vm)}</td>
                  <td className={`hidden sm:table-cell px-3 py-1.5 text-right tabular-nums ${edge === null ? "text-gray-700" : colorPct(edge)}`}>
                    {edge === null ? "—" : `${edge.toFixed(edge >= 100 || edge <= -100 ? 0 : 1)} bp`}
                  </td>
                  <td className="hidden px-3 py-1.5 sm:table-cell">
                    <div className="flex justify-center gap-1">
                      {[r.pw, r.pm, r.pa].map((v, k) => (
                        <span key={k} className={`h-2 w-2 rounded-full ${v > 0 ? "bg-green-500" : v < 0 ? "bg-red-500" : "bg-gray-700"}`} />
                      ))}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {list.length > limit && (
          <button onClick={() => setLimit((l) => l + 200)} className="w-full border-t border-bg-border py-2 text-xs text-gray-400 hover:text-white">
            Afficher plus ({list.length - limit} restants)
          </button>
        )}
        {list.length === 0 && <p className="py-10 text-center text-sm text-gray-500">Sélectionnez au moins un profil.</p>}
      </div>
    </div>
  );
}

// --- Cohorte : positionnement et liquidations ------------------------------------

/** Cache module : changer d'onglet ne doit pas refaire 100 requêtes. */
let cohortCache: { key: string; at: number; positions: TrackedPosition[]; ok: number } | null = null;
const COHORT_TTL_MS = 3 * 60_000;

function useCohortPositions(cohort: LeaderRow[]) {
  const key = cohort.map((r) => r.a).join(",");
  const [state, setState] = useState<{ positions: TrackedPosition[]; ok: number; loading: boolean; progress: number }>(() =>
    cohortCache?.key === key ? { positions: cohortCache.positions, ok: cohortCache.ok, loading: false, progress: 1 } : { positions: [], ok: 0, loading: true, progress: 0 }
  );

  useEffect(() => {
    if (!key) return;
    if (cohortCache?.key === key && Date.now() - cohortCache.at < COHORT_TTL_MS) {
      setState({ positions: cohortCache.positions, ok: cohortCache.ok, loading: false, progress: 1 });
      return;
    }
    let cancelled = false;
    let done = 0;
    const addresses = key.split(",");
    setState((s) => ({ ...s, loading: true, progress: 0 }));
    // Poids : 2 par compte (clearinghouseState), concurrence bornée pour ne pas
    // déclencher la limite de débit du visiteur.
    mapLimit(addresses, 8, async (address) => {
      const st: ClearinghouseState = await hl.clearinghouseState(address);
      done++;
      if (!cancelled && done % 10 === 0) setState((s) => ({ ...s, progress: done / addresses.length }));
      return { address, state: st };
    }).then((results) => {
      if (cancelled) return;
      const ok = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
      const positions = extractPositions(ok);
      cohortCache = { key, at: Date.now(), positions, ok: ok.length };
      setState({ positions, ok: ok.length, loading: false, progress: 1 });
    });
    return () => {
      cancelled = true;
    };
  }, [key]);

  return state;
}

function CohortTabs({ tab, cohort }: { tab: Tab; cohort: LeaderRow[] }) {
  const { positions, ok, loading, progress } = useCohortPositions(cohort);
  const mids = useLiveMidsAll([""]);

  if (loading && positions.length === 0) {
    return (
      <Centered>
        Lecture des positions des {cohort.length} traders suivis… {Math.round(progress * 100)} %
      </Centered>
    );
  }

  const caption = (
    <p className="mb-3 max-w-4xl text-xs leading-relaxed text-gray-500">
      Cohorte : les {cohort.length} meilleurs comptes <span className="text-gray-300">réguliers et directionnels</span> (PnL 30 j, valeur ≥{" "}
      {fmtUsd(COHORT_MIN_VALUE)}) — teneurs de marché, comptes passifs et rebonds exclus, car leurs positions ne traduisent pas une conviction.
      Positions lues en direct sur le DEX principal ({ok} comptes lus).
    </p>
  );

  return tab === "positioning" ? (
    <PositioningTab positions={positions} mids={mids} caption={caption} />
  ) : (
    <LiquidationsTab positions={positions} mids={mids} caption={caption} />
  );
}

function PositioningTab({ positions, mids, caption }: { positions: TrackedPosition[]; mids: Record<string, number>; caption: ReactNode }) {
  const bias = useMemo(() => aggregateBias(positions), [positions]);
  const maxGross = Math.max(1, ...bias.map((b) => b.longUsd + b.shortUsd));

  return (
    <div className="flex flex-col md:min-h-0 md:flex-1">
      {caption}
      <div className="overflow-auto rounded-lg border border-bg-border md:min-h-0 md:flex-1">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10 bg-bg-panel text-xs text-gray-400">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Coin</th>
              <th className="hidden sm:table-cell px-3 py-2 text-right font-medium">Prix</th>
              <th className="hidden sm:table-cell px-3 py-2 text-right font-medium">Longs</th>
              <th className="hidden sm:table-cell px-3 py-2 text-right font-medium">Shorts</th>
              <th className="px-3 py-2 text-left font-medium sm:w-1/3">
                Répartition
                <InfoTip text="Notionnel long (vert) contre short (rouge) de la cohorte, la largeur totale étant proportionnelle à son exposition sur ce coin." />
              </th>
              <th className="px-3 py-2 text-right font-medium">
                Biais
                <InfoTip text="(long − short) / (long + short). +100 % : toute la cohorte est longue." align="right" />
              </th>
            </tr>
          </thead>
          <tbody>
            {bias.map((b) => {
              const gross = b.longUsd + b.shortUsd;
              return (
                <tr key={b.coin} className="border-t border-bg-border">
                  <td className="px-3 py-1.5 font-medium text-white">{b.coin}</td>
                  <td className="hidden sm:table-cell px-3 py-1.5 text-right tabular-nums text-gray-400">{mids[b.coin] ? fmtPrice(mids[b.coin]) : "—"}</td>
                  <td className="hidden sm:table-cell px-3 py-1.5 text-right tabular-nums text-green-400">
                    {fmtUsd(b.longUsd)} <span className="text-[10px] text-gray-600">{b.longTraders}</span>
                  </td>
                  <td className="hidden sm:table-cell px-3 py-1.5 text-right tabular-nums text-red-400">
                    {fmtUsd(b.shortUsd)} <span className="text-[10px] text-gray-600">{b.shortTraders}</span>
                  </td>
                  <td className="px-3 py-1.5">
                    <div className="flex h-2.5 overflow-hidden rounded-full bg-bg-hover" style={{ width: `${Math.max(4, (gross / maxGross) * 100)}%` }}>
                      <div className="bg-green-500/80" style={{ width: `${(b.longUsd / gross) * 100}%` }} />
                      <div className="bg-red-500/80" style={{ width: `${(b.shortUsd / gross) * 100}%` }} />
                    </div>
                  </td>
                  <td className={`px-3 py-1.5 text-right font-semibold tabular-nums ${colorPct(b.bias)}`}>
                    {b.bias > 0 ? "+" : ""}
                    {Math.round(b.bias * 100)} %
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

function LiquidationsTab({ positions, mids, caption }: { positions: TrackedPosition[]; mids: Record<string, number>; caption: ReactNode }) {
  const coins = useMemo(() => aggregateBias(positions).map((b) => b.coin), [positions]);
  const [coin, setCoin] = useState<string | null>(null);
  const selected = coin ?? coins[0] ?? null;
  const price = selected ? mids[selected] ?? 0 : 0;

  const ladder = useMemo(
    () => (selected && price ? liquidationLadder(positions.filter((p) => p.coin === selected), price) : []),
    [positions, selected, price]
  );
  const max = Math.max(1, ...ladder.map((b) => Math.max(b.longUsd, b.shortUsd)));
  const rowsTopDown = [...ladder].reverse();
  const totalLong = ladder.reduce((s, b) => s + b.longUsd, 0);
  const totalShort = ladder.reduce((s, b) => s + b.shortUsd, 0);

  return (
    <div className="flex flex-col md:min-h-0 md:flex-1">
      {caption}
      <div className="mb-3 flex flex-wrap items-center gap-1.5 text-xs">
        {coins.slice(0, 20).map((c) => (
          <button key={c} onClick={() => setCoin(c)} className={`rounded px-2 py-0.5 ${c === selected ? "bg-blue-600 text-white" : "bg-bg-panel text-gray-400 hover:text-white"}`}>
            {c}
          </button>
        ))}
      </div>
      {!selected || !price ? (
        <Centered>Aucune position suivie.</Centered>
      ) : (
        <div className="overflow-auto rounded-lg border border-bg-border bg-bg-panel p-3 md:min-h-0 md:flex-1 md:p-4">
          <div className="mb-3 flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
            <span className="text-gray-300">
              {selected} <span className="tabular-nums text-white">{fmtPrice(price)}</span>
            </span>
            <span className="text-xs text-gray-500">
              Shorts liquidables au-dessus : <span className="text-green-400">{fmtUsd(totalShort)}</span>
            </span>
            <span className="text-xs text-gray-500">
              Longs liquidables en dessous : <span className="text-red-400">{fmtUsd(totalLong)}</span>
            </span>
            <InfoTip text="Prix de liquidation des positions de la cohorte suivie uniquement, par paliers de 2 % autour du prix. Une liquidation de shorts force des ACHATS (vert), une liquidation de longs force des VENTES (rouge) : un gros palier proche peut accélérer le mouvement qui l'atteint. Ce n'est pas l'ensemble du marché." />
          </div>
          <div className="space-y-px font-mono text-[11px]">
            {rowsTopDown.map((b) => {
              const mid = (b.fromPct + b.toPct) / 2;
              const atPrice = b.fromPct < 0 && b.toPct > 0;
              return (
                <div key={b.fromPct} className={`flex items-center gap-2 ${atPrice ? "border-y border-blue-500/40" : ""}`}>
                  <span className="w-16 text-right tabular-nums text-gray-600">{fmtPrice(price * (1 + mid))}</span>
                  <span className={`w-12 text-right tabular-nums ${mid > 0 ? "text-green-600" : "text-red-600"}`}>
                    {mid > 0 ? "+" : ""}
                    {(mid * 100).toFixed(0)} %
                  </span>
                  <div className="flex h-3.5 flex-1 items-center">
                    {b.shortUsd > 0 && <div className="h-full rounded-sm bg-green-500/70" style={{ width: `${(b.shortUsd / max) * 100}%` }} />}
                    {b.longUsd > 0 && <div className="h-full rounded-sm bg-red-500/70" style={{ width: `${(b.longUsd / max) * 100}%` }} />}
                  </div>
                  <span className="w-20 text-right tabular-nums text-gray-500">{b.longUsd + b.shortUsd > 0 ? fmtUsd(b.longUsd + b.shortUsd) : ""}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// --- Primitives ---------------------------------------------------------------------
function SortTh({
  children,
  active,
  onClick,
  help,
  secondary,
}: {
  children: ReactNode;
  active: boolean;
  onClick: () => void;
  help?: string;
  /** Masquée sous 640 px. */
  secondary?: boolean;
}) {
  return (
    <th className={`whitespace-nowrap px-3 py-2 text-right font-medium ${secondary ? "hidden sm:table-cell" : ""}`}>
      <button onClick={onClick} className={active ? "text-white" : "hover:text-white"}>
        {children}
        {active && <span className="ml-1 text-[10px]">▼</span>}
      </button>
      {help && <InfoTip text={help} />}
    </th>
  );
}

function Centered({ children, className = "text-gray-500" }: { children: ReactNode; className?: string }) {
  return <div className={`flex flex-1 items-center justify-center p-8 text-center text-sm ${className}`}>{children}</div>;
}
