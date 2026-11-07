import { useEffect, useMemo, useRef, useState } from "react";
import { hl, type Market, type Trade } from "../hl/client";
import { useHlPoll } from "../hl/hooks";
import { wsManager } from "../hl/ws";
import { NetFlow, OrderBuilder, type Order } from "../tape";
import { href } from "../router";
import { shortAddr } from "../wallet";
import { colorPct, fmtApr, fmtPct, fmtPrice, fmtUsd, fmtUsdSigned, fundingApr } from "../format";
import { InfoTip } from "../components/InfoTip";

const THRESHOLDS = [10_000, 50_000, 100_000, 250_000, 1_000_000];
/** Marchés écoutés : sous ce volume quotidien, les gros ordres sont rarissimes. */
const LISTEN_MIN_VOLUME = 2_000_000;
/** Plancher de conservation : sous le plus petit seuil sélectionnable, inutile de garder l'ordre. */
const KEEP_MIN_USD = THRESHOLDS[0];
const MAX_ORDERS = 600;
const FLOW_WINDOW_MS = 5 * 60_000;

export function TapePage() {
  const markets = useHlPoll(() => hl.allMarkets(), 60_000);
  const [minUsd, setMinUsd] = useState(100_000);
  const [paused, setPaused] = useState(false);
  const [q, setQ] = useState("");
  const [view, setView] = useState<"orders" | "flows">("orders");
  const [orders, setOrders] = useState<Order[]>([]);
  const [flows, setFlows] = useState<{ coin: string; net: number; gross: number }[]>([]);

  const byId = useMemo(() => new Map((markets.data ?? []).map((m) => [m.id, m])), [markets.data]);
  const coins = useMemo(
    () =>
      (markets.data ?? [])
        .filter((m) => m.kind !== "spot" && !m.isDelisted && m.volume24h >= LISTEN_MIN_VOLUME)
        .map((m) => m.id)
        .sort(),
    [markets.data]
  );
  const coinsKey = coins.join(",");

  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    if (!coinsKey) return;
    const builder = new OrderBuilder();
    const flow = new NetFlow(FLOW_WINDOW_MS);
    const all = new Map<string, Order>();
    let dirty = false;

    const onTrades = (data: Trade[]) => {
      if (!Array.isArray(data)) return;
      flow.add(data);
      for (const o of builder.add(data)) {
        if (o.notional >= KEEP_MIN_USD) {
          all.set(o.key, o);
          dirty = true;
        }
      }
    };
    const unsubs = coinsKey.split(",").map((c) => wsManager.subscribe({ type: "trades", coin: c }, onTrades));

    // Rendu cadencé : en période agitée le flux dépasse la centaine de messages
    // par seconde, re-rendre à chacun serait inutile et coûteux.
    const timer = setInterval(() => {
      const now = Date.now();
      builder.prune(now);
      setFlows(flow.snapshot(now));
      if (!dirty || pausedRef.current) return;
      dirty = false;
      const sorted = [...all.values()].sort((a, b) => b.time - a.time);
      for (const o of sorted.slice(MAX_ORDERS)) all.delete(o.key);
      // Copies : le builder mute ses ordres en place, React doit voir des objets neufs.
      setOrders(sorted.slice(0, MAX_ORDERS).map((o) => ({ ...o, makers: new Set(o.makers) })));
    }, 500);

    return () => {
      unsubs.forEach((u) => u());
      clearInterval(timer);
    };
  }, [coinsKey]);

  const query = q.trim().toUpperCase();
  const visible = orders.filter((o) => o.notional >= minUsd && (!query || o.coin.toUpperCase().includes(query)));

  const ranked = flows.filter((f) => f.gross >= 100_000).sort((a, b) => b.net - a.net);
  const inflows = ranked.filter((f) => f.net > 0).slice(0, 8);
  const outflows = ranked.filter((f) => f.net < 0).reverse().slice(0, 8);

  return (
    <main className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-3 md:p-4 xl:flex-row xl:gap-4">
      {/* Sous 1280 px, la pression acheteuse/vendeuse ne tient plus à droite. */}
      <div className="flex shrink-0 rounded-lg border border-bg-border bg-bg-panel p-0.5 xl:hidden">
        {(["orders", "flows"] as const).map((v) => (
          <button
            key={v}
            onClick={() => setView(v)}
            className={`flex-1 rounded-md px-3 py-1.5 text-sm ${view === v ? "bg-bg-hover text-white" : "text-gray-400"}`}
          >
            {v === "orders" ? "Gros ordres" : "Pression 5 min"}
          </button>
        ))}
      </div>

      <div className={`min-h-0 min-w-0 flex-1 flex-col ${view === "flows" ? "hidden xl:flex" : "flex"}`}>
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <h1 className="text-lg font-semibold text-white">Flux live</h1>
          <span className="text-xs text-gray-500">
            {coins.length ? `${coins.length} marchés écoutés en temps réel` : "Préparation…"}
            <InfoTip text="Tous les perps crypto et HIP-3 au-delà de 2 M$ de volume quotidien. Les trades d'un même ordre (qui balaie plusieurs niveaux du carnet) sont regroupés en une ligne. Données directes Hyperliquid, sans délai." />
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-2 text-xs">
            <span className="text-gray-500">Ordres ≥</span>
            <div className="flex rounded-md border border-bg-border bg-bg-panel p-0.5">
              {THRESHOLDS.map((t) => (
                <button key={t} onClick={() => setMinUsd(t)} className={`rounded px-2 py-0.5 ${minUsd === t ? "bg-bg-hover text-white" : "text-gray-500 hover:text-gray-200"}`}>
                  {fmtUsd(t).replace(".0", "")}
                </button>
              ))}
            </div>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Coin…"
              className="w-24 rounded-md border border-bg-border bg-bg-panel px-2 py-1 text-sm text-gray-200 outline-none focus:border-blue-500"
            />
            <button
              onClick={() => setPaused((p) => !p)}
              className={`rounded-md border px-2.5 py-1 ${paused ? "border-amber-500/40 bg-amber-500/10 text-amber-300" : "border-bg-border text-gray-400 hover:text-white"}`}
            >
              {paused ? "▶ Reprendre" : "❚❚ Pause"}
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-bg-border">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-bg-panel text-xs text-gray-400">
              <tr>
                <th className="hidden sm:table-cell px-3 py-2 text-left font-medium">Heure</th>
                <th className="px-3 py-2 text-left font-medium">Marché</th>
                <th className="px-3 py-2 text-left font-medium">
                  Sens
                  <InfoTip text="Côté de l'initiateur (taker) : ACHAT s'il a acheté en agressant les offres, VENTE s'il a vendu sur les demandes." />
                </th>
                <th className="px-3 py-2 text-right font-medium">Notionnel</th>
                <th className="hidden sm:table-cell px-3 py-2 text-right font-medium">
                  Prix moyen
                  <InfoTip text="Prix moyen pondéré des fills de l'ordre." />
                </th>
                <th className="px-3 py-2 text-left font-medium">Initiateur</th>
                <th className="hidden sm:table-cell px-3 py-2 text-left font-medium">Contreparties</th>
                <th className="hidden sm:table-cell px-3 py-2 text-right font-medium">
                  Contexte
                  <InfoTip text="Funding annualisé et variation 24 h du marché au moment de l'ordre." align="right" />
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((o) => (
                <OrderRow key={o.key} order={o} market={byId.get(o.coin)} />
              ))}
              {visible.length === 0 && (
                <tr>
                  <td colSpan={8} className="py-12 text-center text-gray-500">
                    {coins.length ? `En attente d'ordres ≥ ${fmtUsd(minUsd)}…` : "Chargement des marchés…"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <aside className={`min-h-0 flex-col gap-3 overflow-auto xl:flex xl:w-72 xl:flex-none xl:shrink-0 ${view === "flows" ? "flex flex-1" : "hidden"}`}>
        <FlowPanel title="Pression acheteuse" items={inflows} byId={byId} />
        <FlowPanel title="Pression vendeuse" items={outflows} byId={byId} />
      </aside>
    </main>
  );
}

function OrderRow({ order: o, market }: { order: Order; market: Market | undefined }) {
  const buy = o.side === "B";
  const name = market?.name ?? o.coin;
  const single = o.makers.size === 1 ? [...o.makers][0] : null;
  return (
    <tr className={`border-t border-bg-border ${buy ? "flash-up" : "flash-down"}`}>
      <td className="hidden sm:table-cell whitespace-nowrap px-3 py-1.5 text-xs tabular-nums text-gray-500">
        {new Date(o.time).toLocaleTimeString("fr-FR", { hour12: false })}
      </td>
      <td className="whitespace-nowrap px-3 py-1.5">
        <span className="font-medium text-white">{name}</span>
        {market?.kind === "hip3" && <span className="ml-1.5 rounded bg-purple-500/15 px-1 py-px text-[10px] uppercase text-purple-300">{market.dex}</span>}
      </td>
      <td className={`px-3 py-1.5 text-xs font-bold ${buy ? "text-green-400" : "text-red-400"}`}>{buy ? "ACHAT" : "VENTE"}</td>
      <td className={`whitespace-nowrap px-3 py-1.5 text-right font-semibold tabular-nums ${o.notional >= 1e6 ? "text-amber-300" : "text-gray-100"}`}>
        {fmtUsd(o.notional)}
      </td>
      <td className="hidden sm:table-cell whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-gray-400">
        {fmtPrice(o.vwap)}
        {o.fills > 1 && <span className="ml-1 text-[10px] text-gray-600">{o.fills} fills</span>}
      </td>
      <td className="px-3 py-1.5">
        <a href={href("wallet", o.taker)} className="font-mono text-xs text-blue-300 hover:text-blue-200 hover:underline">
          {shortAddr(o.taker)}
        </a>
      </td>
      <td className="hidden sm:table-cell px-3 py-1.5 text-xs text-gray-500">
        {single ? (
          <a href={href("wallet", single)} className="font-mono hover:text-gray-300 hover:underline">
            {shortAddr(single)}
          </a>
        ) : (
          `${o.makers.size} contreparties`
        )}
      </td>
      <td className="hidden sm:table-cell whitespace-nowrap px-3 py-1.5 text-right text-[11px] tabular-nums text-gray-500">
        {market?.funding !== null && market?.funding !== undefined && (
          <span className={colorPct(market.funding)}>{fmtApr(fundingApr(market.funding))}</span>
        )}
        {market && (
          <>
            <span className="mx-1 text-gray-700">·</span>
            <span className={colorPct(market.change24h)}>{fmtPct(market.change24h)}</span>
          </>
        )}
      </td>
    </tr>
  );
}

function FlowPanel({
  title,
  items,
  byId,
}: {
  title: string;
  items: { coin: string; net: number; gross: number }[];
  byId: Map<string, Market>;
}) {
  return (
    <section className="rounded-lg border border-bg-border bg-bg-panel p-3">
      <h3 className="mb-2 flex items-center text-sm font-medium text-gray-300">
        {title} <span className="ml-1 text-xs text-gray-500">5 min</span>
        <InfoTip
          text="Volume initié à l'achat moins volume initié à la vente, sur les 5 dernières minutes et sur TOUS les trades (pas seulement les gros). Le pourcentage mesure le déséquilibre : 100 % = uniquement des acheteurs agressifs."
          align="right"
        />
      </h3>
      {items.length === 0 ? (
        <p className="text-xs text-gray-600">Rien de significatif pour l'instant.</p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((f) => {
            const m = byId.get(f.coin);
            const imbalance = f.net / f.gross;
            return (
              <li key={f.coin} className="text-xs">
                <div className="flex items-baseline justify-between">
                  <span className="font-medium text-gray-200">
                    {m?.name ?? f.coin}
                    {m?.kind === "hip3" && <span className="ml-1 text-[9px] uppercase text-purple-300">{m.dex}</span>}
                  </span>
                  <span className={`tabular-nums ${colorPct(f.net)}`}>{fmtUsdSigned(f.net)}</span>
                </div>
                <div className="mt-0.5 flex items-center gap-2">
                  <div className="h-1 flex-1 overflow-hidden rounded-full bg-bg-hover">
                    <div className={f.net >= 0 ? "h-full bg-green-500/70" : "ml-auto h-full bg-red-500/70"} style={{ width: `${Math.abs(imbalance) * 100}%` }} />
                  </div>
                  <span className="w-9 text-right tabular-nums text-gray-500">{Math.round(Math.abs(imbalance) * 100)} %</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
