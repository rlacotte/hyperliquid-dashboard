import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { hl, num, type Fill, type PortfolioWindow } from "../hl/client";
import { useHlPoll, useLiveMidsAll } from "../hl/hooks";
import { navigate, href } from "../router";
import {
  isAddress,
  liqRisk,
  pnlBreakdown,
  positionView,
  shortAddr,
  type PositionView,
} from "../wallet";
import { notifySettingsStore, useActivity, useNotifySettings, useWatchlist, watchlistStore } from "../stores";
import { describe as describeAction } from "../walletActivity";
import { colorPct, fmtAgo, fmtPct, fmtPrice, fmtUsd, fmtUsdSigned } from "../format";
import { AreaChart } from "../components/AreaChart";
import { InfoTip } from "../components/InfoTip";
import { LivePrice } from "../components/LivePrice";

const WEEK_MS = 7 * 86400_000;

export function WalletPage({ address }: { address?: string }) {
  // Store partagé : la surveillance en direct (WalletWatcher, au niveau de
  // l'app) suit les ajouts et retraits faits ici.
  const watch = useWatchlist();
  const normalized = address?.trim().toLowerCase();
  const valid = normalized ? isAddress(normalized) : false;

  const toggleWatch = (addr: string) => {
    const list = watchlistStore.get();
    watchlistStore.set(
      list.some((w) => w.address === addr)
        ? list.filter((w) => w.address !== addr)
        : [...list, { address: addr, label: shortAddr(addr), addedAt: Date.now() }]
    );
  };

  const rename = (addr: string) => {
    const current = watchlistStore.get().find((w) => w.address === addr);
    const label = window.prompt("Nom affiché dans les notifications :", current?.label ?? shortAddr(addr));
    if (label === null) return;
    const clean = label.trim().slice(0, 32) || shortAddr(addr);
    watchlistStore.set(watchlistStore.get().map((w) => (w.address === addr ? { ...w, label: clean } : w)));
  };

  return (
    <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-3 md:p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold text-white">Wallet</h1>
        <WalletSearch initial={address ?? ""} />
        {watch.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-gray-600">Suivis :</span>
            {watch.map((w) => (
              <a
                key={w.address}
                href={href("wallet", w.address)}
                className={`rounded-md border px-2 py-0.5 font-mono ${
                  w.address === normalized
                    ? "border-blue-500/50 bg-blue-500/10 text-blue-200"
                    : "border-bg-border bg-bg-panel text-gray-400 hover:text-white"
                }`}
              >
                {w.label}
              </a>
            ))}
          </div>
        )}
      </div>

      {watch.length > 0 && <ActivityPanel onRename={rename} />}

      {!address ? (
        <Intro />
      ) : !valid ? (
        <Panel>
          <p className="text-sm text-red-400">« {address} » n'est pas une adresse valide (0x suivi de 40 caractères hexadécimaux).</p>
        </Panel>
      ) : (
        <WalletView
          key={normalized}
          address={normalized!}
          watched={watch.some((w) => w.address === normalized)}
          onToggleWatch={() => toggleWatch(normalized!)}
        />
      )}
    </main>
  );
}

function WalletSearch({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setValue(initial), [initial]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = value.trim();
    if (!isAddress(v)) {
      setError("Adresse invalide");
      return;
    }
    setError(null);
    navigate("wallet", v.toLowerCase());
  };

  return (
    <form onSubmit={submit} className="flex items-center gap-2">
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="0x… adresse à analyser"
        spellCheck={false}
        className="w-[26rem] max-w-full rounded-md border border-bg-border bg-bg-panel px-3 py-1.5 font-mono text-sm text-gray-200 outline-none focus:border-blue-500"
      />
      <button type="submit" className="rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-500">
        Analyser
      </button>
      {error && <span className="text-xs text-red-400">{error}</span>}
    </form>
  );
}

function Intro() {
  return (
    <Panel>
      <div className="max-w-2xl space-y-2 text-sm text-gray-400">
        <p className="text-gray-200">Analysez n'importe quel compte Hyperliquid — toutes les données sont publiques.</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>Positions sur tous les DEX (crypto et HIP-3), avec la distance à la liquidation recalculée en direct.</li>
          <li>
            Décomposition du PnL sur 7 jours : ce que le compte gagne en <em>pariant sur le prix</em> versus ce qu'il encaisse en{" "}
            <em>funding</em> — confondus dans un seul chiffre sur les leaderboards.
          </li>
          <li>Historique de valeur, exécutions récentes, liquidations subies.</li>
        </ul>
        <p className="text-xs text-gray-500">
          Collez une adresse ci-dessus, ou cliquez une adresse dans le flux live. Les comptes suivis sont mémorisés dans ce navigateur
          uniquement.
        </p>
      </div>
    </Panel>
  );
}

// --- Vue d'un compte ----------------------------------------------------------------
function WalletView({ address, watched, onToggleWatch }: { address: string; watched: boolean; onToggleWatch: () => void }) {
  // Poids Hyperliquid (budget 1200/min/IP) : états 2×DEX toutes les 10 s,
  // portfolio 20/min, fills ~120 (2000 lignes) toutes les 2 min.
  const states = useHlPoll(() => hl.allClearinghouseStates(address), 10_000, [address]);
  const portfolio = useHlPoll(() => hl.portfolio(address), 60_000, [address]);
  const fills = useHlPoll(() => hl.userFills(address), 120_000, [address]);
  const spot = useHlPoll(() => hl.spotState(address), 30_000, [address]);
  const funding = useFundingWeek(address);

  const dexs = useMemo(() => {
    const s = new Set<string>([""]);
    for (const { dex, state } of states.data ?? []) if (state.assetPositions.length) s.add(dex);
    return [...s];
  }, [states.data]);
  const mids = useLiveMidsAll(dexs);

  const positions: PositionView[] = useMemo(
    () =>
      (states.data ?? [])
        .flatMap(({ dex, state }) => state.assetPositions.map((ap) => positionView(ap.position, dex, mids[ap.position.coin])))
        .sort((a, b) => b.notional - a.notional),
    [states.data, mids]
  );

  const windows = useMemo(() => new Map(portfolio.data ?? []), [portfolio.data]);

  const perpMargin = (states.data ?? []).reduce((s, { state }) => s + num(state.marginSummary.accountValue), 0);
  const withdrawable = (states.data ?? []).reduce((s, { state }) => s + num(state.withdrawable), 0);
  const exposure = positions.reduce((s, p) => s + p.notional, 0);
  const upnl = positions.reduce((s, p) => s + p.upnl, 0);
  const dayAv = windows.get("day")?.accountValueHistory;
  const totalValue = dayAv?.length ? num(dayAv[dayAv.length - 1][1]) : null;

  const perpWeekPnl = windows.get("perpWeek")?.pnlHistory;
  const breakdown =
    perpWeekPnl?.length && funding
      ? pnlBreakdown(num(perpWeekPnl[perpWeekPnl.length - 1][1]), funding.entries, funding.start, funding.end, funding.complete)
      : null;

  if (states.error && !states.data) return <Panel><p className="text-sm text-red-400">Erreur : {states.error}</p></Panel>;

  const empty = states.data && positions.length === 0 && (totalValue ?? 0) === 0 && (fills.data?.length ?? 0) === 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="break-all font-mono text-sm text-gray-200">{address}</span>
        <button
          onClick={() => navigator.clipboard?.writeText(address)}
          className="rounded border border-bg-border px-2 py-0.5 text-xs text-gray-400 hover:text-white"
          title="Copier l'adresse"
        >
          Copier
        </button>
        <button
          onClick={onToggleWatch}
          className={`rounded border px-2 py-0.5 text-xs ${
            watched ? "border-amber-500/40 bg-amber-500/10 text-amber-300" : "border-bg-border text-gray-400 hover:text-white"
          }`}
        >
          {watched ? "★ Suivi" : "☆ Suivre"}
        </button>
        <a
          href={`https://app.hyperliquid.xyz/explorer/address/${address}`}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-gray-500 hover:text-gray-300"
        >
          Explorer ↗
        </a>
      </div>

      {empty && (
        <Panel>
          <p className="text-sm text-gray-400">Aucune activité trouvée pour ce compte sur Hyperliquid.</p>
        </Panel>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Valeur totale" help="Valeur du compte selon Hyperliquid : marge perp + soldes spot." value={totalValue === null ? "…" : fmtUsd(totalValue)} />
        <Stat label="Marge perp" help="Valeur du compte de marge, tous DEX confondus (crypto + HIP-3)." value={states.data ? fmtUsd(perpMargin) : "…"} />
        <Stat label="Exposition" help="Somme des notionnels des positions ouvertes, au prix courant." value={states.data ? fmtUsd(exposure) : "…"} />
        <Stat
          label="Levier effectif"
          help="Exposition ÷ marge perp. Différent du levier choisi par position : c'est le risque réel du compte."
          value={perpMargin > 0 ? `${(exposure / perpMargin).toFixed(2)}×` : "—"}
        />
        <Stat label="PnL latent" help="Recalculé en direct au prix courant." value={fmtUsdSigned(upnl)} tone={upnl} />
        <Stat label="Retirable" help="Montant retirable sans réduire de position." value={states.data ? fmtUsd(withdrawable) : "…"} />
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <PnlCard breakdown={breakdown} loading={!funding || !portfolio.data} />
        <div className="xl:col-span-2">
          <HistoryCard windows={windows} />
        </div>
      </div>

      <PositionsTable positions={positions} loading={!states.data} />
      <SpotBalances balances={spot.data?.balances ?? []} />
      <FillsTable fills={fills.data} loading={fills.loading} />
    </div>
  );
}

/** Funding des 7 derniers jours, récupéré une fois par adresse (coûteux). */
function useFundingWeek(address: string) {
  const [data, setData] = useState<{ entries: { time: number; delta: { coin: string; usdc: string } }[]; complete: boolean; start: number; end: number } | null>(null);
  useEffect(() => {
    let cancelled = false;
    setData(null);
    const end = Date.now();
    const start = end - WEEK_MS;
    hl.userFundingPaged(address, start, end)
      .then((r) => !cancelled && setData({ ...r, start, end }))
      .catch(() => !cancelled && setData({ entries: [], complete: false, start, end }));
    return () => {
      cancelled = true;
    };
  }, [address]);
  return data;
}

function PnlCard({ breakdown, loading }: { breakdown: ReturnType<typeof pnlBreakdown> | null; loading: boolean }) {
  return (
    <Panel>
      <h3 className="mb-3 flex items-center text-sm font-medium text-gray-300">
        D'où vient le PnL ? <span className="ml-1 text-gray-500">(perps, 7 jours)</span>
        <InfoTip text="Le PnL total mélange deux sources : les paris sur le prix (trading) et le funding encaissé ou payé en portant des positions. Un compte peut afficher un PnL positif tout en perdant sur le prix. Trading = total − funding, frais inclus." />
      </h3>
      {loading || !breakdown ? (
        <p className="text-sm text-gray-500">{loading ? "Calcul…" : "Pas d'historique de PnL."}</p>
      ) : (
        <div className="space-y-2.5">
          <Row label="PnL total" value={breakdown.total} strong />
          <Row label="dont trading (prix + frais)" value={breakdown.trading} />
          <Row label="dont funding" value={breakdown.funding} />
          <Bar breakdown={breakdown} />
          {breakdown.fundingCoverage < 1 && (
            <p className="text-xs text-amber-400/80">
              Compte très actif : funding récupéré sur {Math.round(breakdown.fundingCoverage * 100)} % de la semaine seulement (limite de
              débit). La part funding est sous-estimée en valeur absolue.
            </p>
          )}
        </div>
      )}
    </Panel>
  );
}

function Row({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between text-sm">
      <span className={strong ? "text-gray-200" : "text-gray-500"}>{label}</span>
      <span className={`tabular-nums ${colorPct(value)} ${strong ? "text-base font-semibold" : ""}`}>{fmtUsdSigned(value)}</span>
    </div>
  );
}

function Bar({ breakdown }: { breakdown: { trading: number; funding: number } }) {
  const total = Math.abs(breakdown.trading) + Math.abs(breakdown.funding);
  if (total === 0) return null;
  const t = (Math.abs(breakdown.trading) / total) * 100;
  return (
    <div className="flex h-2 overflow-hidden rounded-full bg-bg-hover" title="Part de chaque source, en valeur absolue">
      <div className={breakdown.trading >= 0 ? "bg-blue-500" : "bg-red-500/70"} style={{ width: `${t}%` }} />
      <div className={breakdown.funding >= 0 ? "bg-purple-500" : "bg-orange-500/70"} style={{ width: `${100 - t}%` }} />
    </div>
  );
}

const HISTORY_WINDOWS: [PortfolioWindow, string][] = [
  ["day", "24 h"],
  ["week", "7 j"],
  ["month", "30 j"],
  ["allTime", "Tout"],
];

function HistoryCard({ windows }: { windows: Map<PortfolioWindow, { accountValueHistory: [number, string][]; pnlHistory: [number, string][] }> }) {
  const [w, setW] = useState<PortfolioWindow>("month");
  const [metric, setMetric] = useState<"pnl" | "value">("pnl");
  const series = windows.get(w);
  const points = useMemo(
    () => (metric === "pnl" ? series?.pnlHistory : series?.accountValueHistory)?.map(([t, v]) => ({ t, v: num(v) })) ?? [],
    [series, metric]
  );

  return (
    <Panel>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="flex items-center text-sm font-medium text-gray-300">
          {metric === "pnl" ? "PnL cumulé" : "Valeur du compte"}
          <InfoTip text="Le PnL cumulé exclut dépôts et retraits ; la valeur du compte les inclut. Une valeur qui monte peut cacher des pertes compensées par des dépôts." />
        </h3>
        <div className="ml-auto flex gap-1 text-xs">
          {(
            [
              ["pnl", "PnL"],
              ["value", "Valeur"],
            ] as const
          ).map(([m, l]) => (
            <button key={m} onClick={() => setMetric(m)} className={`rounded px-2 py-0.5 ${metric === m ? "bg-bg-hover text-white" : "text-gray-500"}`}>
              {l}
            </button>
          ))}
          <span className="mx-1 text-gray-700">|</span>
          {HISTORY_WINDOWS.map(([k, l]) => (
            <button key={k} onClick={() => setW(k)} className={`rounded px-2 py-0.5 ${w === k ? "bg-blue-600 text-white" : "text-gray-500 hover:text-white"}`}>
              {l}
            </button>
          ))}
        </div>
      </div>
      <AreaChart points={points} tone={metric === "pnl" ? "auto" : "blue"} />
    </Panel>
  );
}

function PositionsTable({ positions, loading }: { positions: PositionView[]; loading: boolean }) {
  return (
    <Panel padded={false}>
      <h3 className="px-4 pt-3 text-sm font-medium text-gray-300">
        Positions ouvertes <span className="text-gray-500">({positions.length})</span>
      </h3>
      {loading ? (
        <p className="p-4 text-sm text-gray-500">Chargement…</p>
      ) : positions.length === 0 ? (
        <p className="p-4 text-sm text-gray-500">Aucune position ouverte.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="mt-2 w-full text-sm">
            <thead className="text-gray-500">
              <tr className="text-xs">
                <Th align="left">Marché</Th>
                <Th>Côté</Th>
                <Th>Notionnel</Th>
                <Th>Entrée</Th>
                <Th>Prix</Th>
                <Th>PnL latent</Th>
                <Th>ROE</Th>
                <Th>Levier</Th>
                <Th>Liquidation</Th>
                <Th help="Mouvement de prix défavorable avant liquidation, au prix courant. En cross, la marge du reste du compte peut repousser ce seuil.">
                  Distance
                </Th>
                <Th help="Funding encaissé (+) ou payé (−) depuis l'ouverture de la position." last>
                  Funding
                </Th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => {
                const risk = liqRisk(p.liqDistance);
                return (
                  <tr key={`${p.dex}:${p.coin}`} className="border-t border-bg-border">
                    <td className="px-3 py-1.5 font-medium text-white">
                      {p.dex ? p.coin.slice(p.dex.length + 1) : p.coin}
                      {p.dex && <span className="ml-1.5 rounded bg-purple-500/15 px-1 py-px text-[10px] uppercase text-purple-300">{p.dex}</span>}
                    </td>
                    <td className={`px-3 py-1.5 text-right text-xs font-semibold ${p.side === "long" ? "text-green-400" : "text-red-400"}`}>
                      {p.side === "long" ? "LONG" : "SHORT"}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-gray-200">{fmtUsd(p.notional)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-gray-400">{fmtPrice(p.entryPx)}</td>
                    <td className="px-3 py-1.5 text-right">
                      <LivePrice value={p.markPx} className="text-gray-200" />
                    </td>
                    <td className={`px-3 py-1.5 text-right tabular-nums ${colorPct(p.upnl)}`}>{fmtUsdSigned(p.upnl)}</td>
                    <td className={`px-3 py-1.5 text-right tabular-nums ${colorPct(p.roe)}`}>{fmtPct(p.roe)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-gray-400">
                      {p.leverage}× <span className="text-[10px] text-gray-600">{p.leverageType === "cross" ? "cross" : "iso"}</span>
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-gray-400">{p.liqPx ? fmtPrice(p.liqPx) : "—"}</td>
                    <td
                      className={`px-3 py-1.5 text-right font-semibold tabular-nums ${
                        risk === "high" ? "text-red-400" : risk === "medium" ? "text-amber-400" : risk === "low" ? "text-gray-300" : "text-gray-600"
                      }`}
                    >
                      {p.liqDistance === null ? "—" : `${(p.liqDistance * 100).toFixed(1)} %`}
                    </td>
                    <td className={`px-3 py-1.5 text-right tabular-nums ${colorPct(p.fundingSinceOpen)}`}>{fmtUsdSigned(p.fundingSinceOpen)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function SpotBalances({ balances }: { balances: { coin: string; total: string; entryNtl: string }[] }) {
  const held = balances.filter((b) => num(b.total) > 0);
  if (held.length === 0) return null;
  return (
    <Panel>
      <h3 className="mb-2 text-sm font-medium text-gray-300">Soldes spot</h3>
      <div className="flex flex-wrap gap-2">
        {held.map((b) => (
          <span key={b.coin} className="rounded-md border border-bg-border bg-bg-base px-2.5 py-1 text-xs">
            <span className="font-medium text-gray-200">{b.coin}</span>{" "}
            <span className="tabular-nums text-gray-400">{num(b.total).toLocaleString("fr-FR", { maximumFractionDigits: 4 })}</span>
          </span>
        ))}
      </div>
    </Panel>
  );
}

const DIR_LABEL: Record<string, string> = {
  "Open Long": "Ouverture long",
  "Close Long": "Clôture long",
  "Open Short": "Ouverture short",
  "Close Short": "Clôture short",
  "Long > Short": "Bascule → short",
  "Short > Long": "Bascule → long",
  Buy: "Achat",
  Sell: "Vente",
};

function FillsTable({ fills, loading }: { fills: Fill[] | null; loading: boolean }) {
  const [limit, setLimit] = useState(50);
  const list = fills ?? [];
  const covered = list.length > 1 ? list[0].time - list[list.length - 1].time : 0;

  return (
    <Panel padded={false}>
      <div className="flex flex-wrap items-baseline gap-2 px-4 pt-3">
        <h3 className="text-sm font-medium text-gray-300">Exécutions récentes</h3>
        {list.length > 0 && (
          <span className="text-xs text-gray-500">
            {list.length} dernières (l'API en expose 2 000 au plus), couvrant {fmtAgo(Date.now() - covered, Date.now())}
          </span>
        )}
      </div>
      {loading && !fills ? (
        <p className="p-4 text-sm text-gray-500">Chargement…</p>
      ) : list.length === 0 ? (
        <p className="p-4 text-sm text-gray-500">Aucune exécution.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="mt-2 w-full text-sm">
            <thead className="text-xs text-gray-500">
              <tr>
                <Th align="left">Quand</Th>
                <Th align="left">Marché</Th>
                <Th align="left">Action</Th>
                <Th>Prix</Th>
                <Th>Notionnel</Th>
                <Th>PnL réalisé</Th>
                <Th last>Frais</Th>
              </tr>
            </thead>
            <tbody>
              {list.slice(0, limit).map((f, i) => {
                const notional = num(f.px) * num(f.sz);
                const pnl = num(f.closedPnl);
                return (
                  <tr key={`${f.hash}-${i}`} className="border-t border-bg-border">
                    <td className="px-3 py-1.5 text-xs text-gray-500" title={new Date(f.time).toLocaleString("fr-FR")}>
                      il y a {fmtAgo(f.time)}
                    </td>
                    <td className="px-3 py-1.5 font-medium text-white">{f.coin.startsWith("@") ? f.coin : f.coin.replace(/^[a-z]+:/, "")}</td>
                    <td className="px-3 py-1.5 text-xs text-gray-300">
                      {DIR_LABEL[f.dir] ?? f.dir}
                      {f.liquidation && <span className="ml-1.5 rounded bg-red-500/20 px-1 text-[10px] font-bold text-red-300">LIQUIDATION</span>}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-gray-400">{fmtPrice(num(f.px))}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-gray-300">{fmtUsd(notional)}</td>
                    <td className={`px-3 py-1.5 text-right tabular-nums ${pnl === 0 ? "text-gray-600" : colorPct(pnl)}`}>
                      {pnl === 0 ? "—" : fmtUsdSigned(pnl)}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-gray-500">{fmtUsd(num(f.fee))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {list.length > limit && (
            <button onClick={() => setLimit((l) => l + 100)} className="w-full border-t border-bg-border py-2 text-xs text-gray-400 hover:text-white">
              Afficher plus ({list.length - limit} restantes)
            </button>
          )}
        </div>
      )}
    </Panel>
  );
}

// --- Primitives ------------------------------------------------------------------------
function Panel({ children, padded = true }: { children: ReactNode; padded?: boolean }) {
  return <section className={`rounded-lg border border-bg-border bg-bg-panel ${padded ? "p-4" : "pb-1"}`}>{children}</section>;
}

function Stat({ label, value, help, tone }: { label: string; value: string; help?: string; tone?: number }) {
  return (
    <div className="rounded-lg border border-bg-border bg-bg-panel px-3 py-2.5">
      <div className="flex items-center text-xs text-gray-500">
        {label}
        {help && <InfoTip text={help} />}
      </div>
      <div className={`mt-1 text-lg font-semibold tabular-nums ${tone === undefined ? "text-white" : colorPct(tone)}`}>{value}</div>
    </div>
  );
}

function Th({ children, align = "right", help, last }: { children: ReactNode; align?: "left" | "right"; help?: string; last?: boolean }) {
  return (
    <th className={`whitespace-nowrap px-3 py-1.5 font-medium ${align === "left" ? "text-left" : "text-right"}`}>
      {children}
      {help && <InfoTip text={help} align={last ? "right" : "center"} />}
    </th>
  );
}


// --- Activité en direct des wallets suivis --------------------------------------------
const MIN_NOTIONALS = [0, 10_000, 25_000, 100_000, 500_000];

function ActivityPanel({ onRename }: { onRename: (addr: string) => void }) {
  const watch = useWatchlist();
  const settings = useNotifySettings();
  const activity = useActivity();
  const labels = useMemo(() => new Map(watch.map((w) => [w.address, w.label])), [watch]);
  const supported = typeof Notification !== "undefined";
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(supported ? Notification.permission : "unsupported");

  const enable = async () => {
    if (!supported) return;
    // La permission ne peut être demandée qu'en réponse à un geste utilisateur.
    const p = await Notification.requestPermission();
    setPermission(p);
    notifySettingsStore.set({ ...settings, enabled: p === "granted" });
  };

  return (
    <Panel>
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <h3 className="flex items-center text-sm font-medium text-gray-300">
          Activité en direct des wallets suivis
          <InfoTip text="Ouvertures, renforcements, réductions, clôtures et liquidations des wallets que vous suivez, en temps réel. Les exécutions d'un même marché à quelques secondes d'intervalle sont regroupées en une action. Un onglet du dashboard doit rester ouvert : sans compte, aucun serveur ne peut vous prévenir hors ligne." />
        </h3>
        <div className="ml-auto flex flex-wrap items-center gap-2 text-xs">
          <label className="flex items-center gap-1.5 text-gray-400">
            Alerter dès
            <select
              value={settings.minNotional}
              onChange={(e) => notifySettingsStore.set({ ...settings, minNotional: Number(e.target.value) })}
              className="rounded border border-bg-border bg-bg-base px-1.5 py-0.5 text-gray-200"
            >
              {MIN_NOTIONALS.map((v) => (
                <option key={v} value={v}>
                  {v === 0 ? "toute action" : fmtUsd(v)}
                </option>
              ))}
            </select>
          </label>
          {permission === "unsupported" ? (
            <span className="text-gray-600">Notifications non prises en charge par ce navigateur</span>
          ) : permission === "denied" ? (
            <span className="text-amber-400/80" title="À réautoriser dans les réglages du site du navigateur.">
              Notifications bloquées par le navigateur
            </span>
          ) : settings.enabled && permission === "granted" ? (
            <button
              onClick={() => notifySettingsStore.set({ ...settings, enabled: false })}
              className="rounded border border-green-500/40 bg-green-500/10 px-2 py-0.5 text-green-300"
            >
              🔔 Notifications actives
            </button>
          ) : (
            <button onClick={enable} className="rounded bg-blue-600 px-2 py-0.5 text-white hover:bg-blue-500">
              Activer les notifications
            </button>
          )}
        </div>
      </div>

      <div className="mb-2 flex flex-wrap gap-1.5 text-xs">
        {watch.map((w) => (
          <span key={w.address} className="inline-flex items-center gap-1 rounded-md border border-bg-border bg-bg-base px-2 py-0.5">
            <a href={href("wallet", w.address)} className="text-gray-300 hover:text-white">
              {w.label}
            </a>
            <button onClick={() => onRename(w.address)} className="text-gray-600 hover:text-gray-300" title="Renommer">
              ✎
            </button>
          </span>
        ))}
      </div>

      {activity.length === 0 ? (
        <p className="text-xs text-gray-500">En écoute… les actions apparaîtront ici dès qu'un wallet suivi exécute un ordre.</p>
      ) : (
        <ul className="max-h-72 space-y-1 overflow-auto text-sm">
          {activity.map((a) => {
            const { title, body } = describeAction(a, labels.get(a.user) ?? shortAddr(a.user), fmtUsd);
            const big = a.kind === "liquidation" || a.notional >= settings.minNotional;
            return (
              <li key={a.key} className={`flex items-baseline gap-2 ${big ? "" : "opacity-60"}`}>
                <span className="w-16 shrink-0 text-xs tabular-nums text-gray-500">
                  {new Date(a.time).toLocaleTimeString("fr-FR", { hour12: false })}
                </span>
                <a href={href("wallet", a.user)} className={`hover:underline ${a.kind === "liquidation" ? "font-semibold text-red-300" : a.side === "long" ? "text-green-300" : "text-red-300"}`}>
                  {title}
                </a>
                <span className="text-xs text-gray-500">{body}</span>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
