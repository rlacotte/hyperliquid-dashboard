import { useMemo, useState, type ReactNode } from "react";
import { hl, type Market } from "../hl/client";
import { api } from "../api";
import { usePolling } from "../hooks/usePolling";
import { useHlPoll, useLiveMidsAll } from "../hl/hooks";
import { useNow, fmtCountdown } from "../hooks/useNow";
import {
  breakEvenDays,
  buildArbRows,
  nextFundingAfter,
  roundTripFee,
  VENUE_LABEL,
  VENUES,
  type ArbRow,
  type FeeMode,
  type Venue,
} from "../funding";
import { colorPct, fmtApr, fmtFunding, fmtUsd, fundingApr } from "../format";
import { InfoTip } from "../components/InfoTip";
import { AssetDetail } from "../components/AssetDetail";

type Tab = "arb" | "extremes";

const OI_FLOORS = [0, 1e6, 5e6, 25e6];
/** Persistance à partir de laquelle un écart est considéré exploitable (et alerte). */
const PERSISTENT_H = 2;

function fmtDuration(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ${String(min % 60).padStart(2, "0")}`;
  return `${Math.floor(h / 24)} j`;
}

export function FundingPage() {
  const [tab, setTab] = useState<Tab>("arb");
  const [selected, setSelected] = useState<Market | null>(null);

  return (
    <main className="flex flex-1 flex-col overflow-hidden p-4">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold text-white">Funding</h1>
        <div className="flex rounded-lg border border-bg-border bg-bg-panel p-0.5">
          {(
            [
              ["arb", "Arbitrage CEX"],
              ["extremes", "Extrêmes Hyperliquid"],
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
      </div>

      {tab === "arb" ? <ArbTab onSelect={setSelected} /> : <ExtremesTab onSelect={setSelected} />}

      {selected && <DetailWithLivePrice market={selected} onClose={() => setSelected(null)} />}
    </main>
  );
}

function DetailWithLivePrice({ market, onClose }: { market: Market; onClose: () => void }) {
  const mids = useLiveMidsAll([market.dex]);
  return <AssetDetail market={market} livePx={mids[market.id]} confluence={undefined} onClose={onClose} />;
}

// --- Arbitrage Hyperliquid ↔ CEX ------------------------------------------------
function ArbTab({ onSelect }: { onSelect: (m: Market) => void }) {
  // Les taux prédits bougent lentement : une minute suffit. Le compte à rebours
  // est calculé localement à partir de nextFundingTime.
  const predicted = useHlPoll(() => hl.predictedFundings(), 60_000);
  const perps = useHlPoll(() => hl.perps(""), 60_000);
  // Durée des écarts : seule une mémoire côté serveur peut la donner (suivi
  // toutes les 5 min, cf. backend/app/funding_arb.py).
  const tracked = usePolling(() => api.fundingArb(), 60_000);
  const now = useNow(1000);

  const [feeMode, setFeeMode] = useState<FeeMode>("taker");
  const [requireHl, setRequireHl] = useState(true);
  const [minOi, setMinOi] = useState(1e6);
  const [persistentOnly, setPersistentOnly] = useState(false);
  const [q, setQ] = useState("");

  /** Depuis quand l'écart dure, si le suivi serveur voit LA MÊME paire. */
  const sinceOf = (r: ArbRow): number | null => {
    const t = tracked.data?.coins[r.coin];
    return t && r.short && r.long && t.short === r.short.venue && t.long === r.long.venue ? t.since : null;
  };

  const marketById = useMemo(() => new Map((perps.data ?? []).map((m) => [m.id, m])), [perps.data]);

  const rows = useMemo(() => {
    if (!predicted.data) return [];
    const query = q.trim().toUpperCase();
    return buildArbRows(predicted.data, requireHl)
      .filter((r) => r.short && r.long)
      .filter((r) => (marketById.get(r.coin)?.openInterestUsd ?? 0) >= minOi)
      .filter((r) => !query || r.coin.toUpperCase().includes(query))
      .filter((r) => !persistentOnly || ((s) => s !== null && Date.now() - s >= PERSISTENT_H * 3600_000)(sinceOf(r)))
      .sort((a, b) => b.spreadApr - a.spreadApr);
  }, [predicted.data, requireHl, minOi, q, marketById, persistentOnly, tracked.data]);

  if (predicted.error && !predicted.data) return <Centered className="text-red-400">Erreur : {predicted.error}</Centered>;
  if (!predicted.data) return <Centered>Chargement des taux prédits…</Centered>;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p className="mb-3 max-w-4xl text-xs leading-relaxed text-gray-500">
        Position delta-neutre : <span className="text-gray-300">short</span> là où le funding est le plus élevé,{" "}
        <span className="text-gray-300">long</span> là où il est le plus bas — on encaisse l'écart sans exposition au prix.
        Tous les taux sont annualisés (Hyperliquid paie toutes les heures, Binance et Bybit toutes les 4 ou 8 h). Le seuil
        de rentabilité suppose l'écart constant et des frais au palier de base, ouverture et fermeture des deux jambes.
      </p>

      <div className="mb-3 flex flex-wrap items-center gap-3 text-xs">
        <Segmented
          value={feeMode}
          onChange={setFeeMode}
          options={[
            ["taker", "Taker"],
            ["maker", "Maker"],
          ]}
          help="Ordres au marché (taker) ou à cours limité qui fournissent de la liquidité (maker, frais plus bas)."
        />
        <label className="flex items-center gap-1.5 text-gray-400">
          OI Hyperliquid min.
          <select
            value={minOi}
            onChange={(e) => setMinOi(Number(e.target.value))}
            className="rounded border border-bg-border bg-bg-panel px-1.5 py-1 text-gray-200"
          >
            {OI_FLOORS.map((v) => (
              <option key={v} value={v}>
                {v === 0 ? "aucun" : fmtUsd(v)}
              </option>
            ))}
          </select>
          <InfoTip text="Un écart spectaculaire sur un marché sans profondeur n'est pas exploitable : l'entrée elle-même déplacerait le prix. Filtre sur l'open interest Hyperliquid." />
        </label>
        <label className="flex cursor-pointer items-center gap-1.5 text-gray-400">
          <input type="checkbox" checked={!requireHl} onChange={(e) => setRequireHl(!e.target.checked)} className="accent-blue-500" />
          Inclure Binance ↔ Bybit
        </label>
        <label className="flex cursor-pointer items-center gap-1.5 text-gray-400">
          <input type="checkbox" checked={persistentOnly} onChange={(e) => setPersistentOnly(e.target.checked)} className="accent-blue-500" />
          Persistants (≥ {PERSISTENT_H} h)
          <InfoTip text="Un écart apparu il y a quelques minutes est souvent un artefact de période de financement. Un écart qui tient depuis plusieurs heures avec la même paire de plateformes est une vraie opportunité — c'est aussi la condition des alertes d'arbitrage." />
        </label>
        <span className="text-gray-600">{rows.length} opportunités</span>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filtrer…"
          className="ml-auto w-32 rounded-md border border-bg-border bg-bg-panel px-3 py-1.5 text-sm text-gray-200 outline-none focus:border-blue-500"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-bg-border">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10 bg-bg-panel text-gray-400">
            <tr>
              <Th align="left">Coin</Th>
              {VENUES.map((v) => (
                <Th key={v} help={`Funding prédit pour la prochaine période sur ${VENUE_LABEL[v]}, annualisé.`}>
                  {VENUE_LABEL[v]}
                </Th>
              ))}
              <Th align="left" help="Jambe à shorter (S) et jambe à acheter (L).">
                Stratégie
              </Th>
              <Th help="Funding annualisé encaissé par la position delta-neutre, avant frais.">Écart</Th>
              <Th help="Jours de portage pour que le funding encaissé couvre les frais d'aller-retour, à écart constant.">
                Rentable en
              </Th>
              <Th help="Depuis quand l'écart dépasse 15 %/an avec cette même paire de plateformes, sans interruption (suivi serveur toutes les 5 min).">
                Depuis
              </Th>
              <Th help="Open interest du marché sur Hyperliquid.">OI HL</Th>
              <Th align="right" help="Hyperliquid règle le funding toutes les heures." last>
                Prochain HL
              </Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <ArbLine key={r.coin} row={r} feeMode={feeMode} now={now} since={sinceOf(r)} market={marketById.get(r.coin)} onSelect={onSelect} />
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={10} className="py-10 text-center text-gray-500">
                  Aucune opportunité avec ces filtres.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ArbLine({
  row,
  feeMode,
  now,
  since,
  market,
  onSelect,
}: {
  row: ArbRow;
  feeMode: FeeMode;
  now: number;
  since: number | null;
  market: Market | undefined;
  onSelect: (m: Market) => void;
}) {
  const short = row.short!;
  const long = row.long!;
  const fee = roundTripFee(short.venue, long.venue, feeMode);
  const be = breakEvenDays(row.spreadApr, fee);
  const hlRate = row.rates.HlPerp;
  const hlNext = hlRate ? nextFundingAfter(hlRate.nextFundingTime, hlRate.intervalHours, now) : undefined;

  const legOf = (v: Venue) => (v === short.venue ? "S" : v === long.venue ? "L" : null);

  return (
    <tr
      onClick={() => market && onSelect(market)}
      className={`border-t border-bg-border hover:bg-bg-hover ${market ? "cursor-pointer" : ""}`}
    >
      <td className="px-3 py-1.5 font-medium text-white">{row.coin}</td>
      {VENUES.map((v) => {
        const r = row.rates[v];
        const leg = legOf(v);
        return (
          <td key={v} className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums">
            {r ? (
              <span className="inline-flex items-center gap-1.5">
                {leg && (
                  <span
                    className={`rounded px-1 text-[10px] font-bold ${
                      leg === "S" ? "bg-red-500/20 text-red-300" : "bg-green-500/20 text-green-300"
                    }`}
                  >
                    {leg}
                  </span>
                )}
                <span className={colorPct(r.apr)} title={`${fmtFunding(r.rate)} toutes les ${r.intervalHours} h`}>
                  {fmtApr(r.apr)}
                </span>
              </span>
            ) : (
              <span className="text-gray-700">—</span>
            )}
          </td>
        );
      })}
      <td className="whitespace-nowrap px-3 py-1.5 text-xs text-gray-300">
        <span className="text-red-300">Short {VENUE_LABEL[short.venue]}</span>
        <span className="text-gray-600"> · </span>
        <span className="text-green-300">Long {VENUE_LABEL[long.venue]}</span>
      </td>
      <td className="px-3 py-1.5 text-right font-semibold tabular-nums text-white">{fmtApr(row.spreadApr)}</td>
      <td className={`px-3 py-1.5 text-right tabular-nums ${be !== null && be <= 3 ? "text-green-400" : be !== null && be <= 14 ? "text-gray-300" : "text-gray-500"}`}>
        {be === null ? "—" : be < 1 ? "< 1 j" : `${be.toFixed(1)} j`}
      </td>
      <td
        className={`whitespace-nowrap px-3 py-1.5 text-right tabular-nums ${
          since !== null && now - since >= PERSISTENT_H * 3600_000 ? "font-semibold text-amber-300" : "text-gray-500"
        }`}
      >
        {since === null ? "—" : fmtDuration(now - since)}
      </td>
      <td className="px-3 py-1.5 text-right tabular-nums text-gray-400">
        {market?.openInterestUsd ? fmtUsd(market.openInterestUsd) : "—"}
      </td>
      <td className="px-3 py-1.5 text-right tabular-nums text-gray-500">{hlNext ? fmtCountdown(hlNext - now) : "—"}</td>
    </tr>
  );
}

// --- Extrêmes Hyperliquid (y compris HIP-3) ----------------------------------------
function ExtremesTab({ onSelect }: { onSelect: (m: Market) => void }) {
  const markets = useHlPoll(() => hl.allMarkets(), 60_000);
  const [minOi, setMinOi] = useState(1e6);
  const [kind, setKind] = useState<"all" | "perp" | "hip3">("all");

  const rows = useMemo(
    () =>
      (markets.data ?? [])
        .filter((m) => m.funding !== null && !m.isDelisted)
        .filter((m) => kind === "all" || m.kind === kind)
        .filter((m) => (m.openInterestUsd ?? 0) >= minOi)
        .sort((a, b) => Math.abs(b.funding!) - Math.abs(a.funding!)),
    [markets.data, minOi, kind]
  );

  if (markets.error && !markets.data) return <Centered className="text-red-400">Erreur : {markets.error}</Centered>;
  if (!markets.data) return <Centered>Chargement…</Centered>;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p className="mb-3 max-w-4xl text-xs leading-relaxed text-gray-500">
        Les funding les plus extrêmes de Hyperliquid, y compris les marchés HIP-3 (actions, matières premières…) qui
        n'existent pas sur Binance ni Bybit et échappent donc à l'arbitrage classique. Un funding extrême signale un
        positionnement déséquilibré ; encaisser le funding expose au prix, ce n'est pas un arbitrage. Les marchés HIP-3
        facturent des frais doublés.
      </p>
      <div className="mb-3 flex flex-wrap items-center gap-3 text-xs">
        <Segmented
          value={kind}
          onChange={setKind}
          options={[
            ["all", "Tous"],
            ["perp", "Crypto"],
            ["hip3", "HIP-3"],
          ]}
        />
        <label className="flex items-center gap-1.5 text-gray-400">
          OI min.
          <select
            value={minOi}
            onChange={(e) => setMinOi(Number(e.target.value))}
            className="rounded border border-bg-border bg-bg-panel px-1.5 py-1 text-gray-200"
          >
            {OI_FLOORS.map((v) => (
              <option key={v} value={v}>
                {v === 0 ? "aucun" : fmtUsd(v)}
              </option>
            ))}
          </select>
        </label>
        <span className="text-gray-600">{rows.length} marchés</span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-bg-border">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10 bg-bg-panel text-gray-400">
            <tr>
              <Th align="left">Marché</Th>
              <Th help="Taux réglé chaque heure.">Funding 1h</Th>
              <Th help="Le même taux annualisé.">APR</Th>
              <Th align="left" help="Côté qui reçoit le funding : les shorts si le taux est positif, les longs s'il est négatif.">
                Encaissent
              </Th>
              <Th>Open interest</Th>
              <Th last>Volume 24h</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => {
              const apr = fundingApr(m.funding!);
              return (
                <tr key={m.id} onClick={() => onSelect(m)} className="cursor-pointer border-t border-bg-border hover:bg-bg-hover">
                  <td className="px-3 py-1.5">
                    <span className="font-medium text-white">{m.name}</span>
                    {m.kind === "hip3" && (
                      <span className="ml-1.5 rounded bg-purple-500/15 px-1 py-px text-[10px] font-medium uppercase text-purple-300">
                        {m.dex}
                      </span>
                    )}
                  </td>
                  <td className={`px-3 py-1.5 text-right tabular-nums ${colorPct(m.funding!)}`}>{fmtFunding(m.funding!)}</td>
                  <td className={`px-3 py-1.5 text-right font-semibold tabular-nums ${colorPct(apr)}`}>{fmtApr(apr)}</td>
                  <td className="px-3 py-1.5 text-xs text-gray-300">{m.funding! > 0 ? "Shorts" : m.funding! < 0 ? "Longs" : "—"}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-gray-400">{fmtUsd(m.openInterestUsd ?? 0)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-gray-400">{fmtUsd(m.volume24h)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// --- Petits composants ------------------------------------------------------------
function Th({
  children,
  align = "right",
  help,
  last,
}: {
  children: ReactNode;
  align?: "left" | "right";
  help?: string;
  last?: boolean;
}) {
  return (
    <th className={`whitespace-nowrap px-3 py-2.5 font-medium ${align === "left" ? "text-left" : "text-right"}`}>
      {children}
      {help && <InfoTip text={help} align={last ? "right" : "center"} />}
    </th>
  );
}

function Segmented<T extends string>({
  value,
  onChange,
  options,
  help,
}: {
  value: T;
  onChange: (v: T) => void;
  options: [T, string][];
  help?: string;
}) {
  return (
    <span className="inline-flex items-center">
      <span className="flex rounded-md border border-bg-border bg-bg-panel p-0.5">
        {options.map(([v, label]) => (
          <button
            key={v}
            onClick={() => onChange(v)}
            className={`rounded px-2 py-0.5 ${value === v ? "bg-bg-hover text-white" : "text-gray-500 hover:text-gray-200"}`}
          >
            {label}
          </button>
        ))}
      </span>
      {help && <InfoTip text={help} />}
    </span>
  );
}

function Centered({ children, className = "text-gray-500" }: { children: ReactNode; className?: string }) {
  return <div className={`flex flex-1 items-center justify-center ${className}`}>{children}</div>;
}
