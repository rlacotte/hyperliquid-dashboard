import { useMemo, useState, type ReactNode } from "react";
import { info, num } from "../hl/client";
import { useHlPoll, useLiveMidsAll } from "../hl/hooks";
import { mapLimit } from "../smartmoney";
import { useNow } from "../hooks/useNow";
import {
  buildLadders,
  distribution,
  impliedMedian,
  isLiquid,
  MAX_SPREAD,
  probAbove,
  quote,
  type Distribution,
  type Ladder,
  type RawOutcome,
} from "../outcomes";
import { fmtPrice } from "../format";
import { InfoTip } from "../components/InfoTip";
import { LivePrice } from "../components/LivePrice";

/** Carnets : une requête (poids 2) par cotation — rafraîchis toutes les 2 min. */
const BOOKS_EVERY_MS = 120_000;

async function loadLadders(signal: AbortSignal): Promise<Ladder[]> {
  const [meta, mids] = await Promise.all([
    info<{ outcomes: RawOutcome[] }>({ type: "outcomeMeta" }, signal),
    info<Record<string, string>>({ type: "allMids" }, signal),
  ]);
  const ladders = buildLadders(meta.outcomes, mids, Date.now());
  // Liquidité de chaque cotation « Oui » : le flux websocket bbo ne renvoie
  // aucun état initial sur ces marchés peu actifs (vérifié), d'où le carnet REST.
  const points = ladders.flatMap((l) => l.points);
  const books = await mapLimit(points, 6, (p) =>
    info<{ levels: [{ px: string }[], { px: string }[]] }>({ type: "l2Book", coin: p.coin }, signal)
  );
  books.forEach((r, i) => {
    if (r.status !== "fulfilled") return;
    const [bids, asks] = r.value.levels ?? [[], []];
    points[i].bid = bids[0] ? num(bids[0].px) : null;
    points[i].ask = asks[0] ? num(asks[0].px) : null;
  });
  return ladders;
}

export function PredictionsPage() {
  const ladders = useHlPoll(loadLadders, BOOKS_EVERY_MS);
  const [showRejected, setShowRejected] = useState(false);

  const analysed = useMemo(
    () => (ladders.data ?? []).map((l) => ({ ladder: l, dist: distribution(l) })),
    [ladders.data]
  );
  const usable = analysed.filter((a) => a.dist);
  const rejected = analysed.filter((a) => !a.dist);

  const dexs = useMemo(() => {
    const s = new Set<string>([""]);
    for (const { ladder } of analysed) if (ladder.underlying.includes(":")) s.add(ladder.underlying.split(":")[0]);
    return [...s];
  }, [analysed]);
  const mids = useLiveMidsAll(dexs);

  return (
    <main className="flex flex-1 flex-col gap-4 overflow-auto p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold text-white">Prédictions de prix</h1>
        {ladders.data && (
          <span className="text-xs text-gray-500">
            {analysed.length} échelles cotées · {usable.length} exploitables
          </span>
        )}
      </div>

      <section className="max-w-5xl rounded-lg border border-bg-border bg-bg-panel p-4 text-xs leading-relaxed text-gray-400">
        <p className="mb-1.5 text-sm text-gray-200">
          Ce que les marchés d'issue Hyperliquid disent du prix d'un actif à une échéance donnée.
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            Chaque marché paie si le cours finit <span className="text-gray-300">au-dessus d'un seuil</span>. Une échelle de seuils pour une même
            échéance donne la probabilité de chaque tranche de prix, et la médiane implicite.
          </li>
          <li>
            <span className="text-gray-300">Liquidité exigée</span> : une cotation sans carnet des deux côtés, ou avec plus de {Math.round(MAX_SPREAD * 100)} points
            d'écart entre achat et vente, est écartée. Une distribution calculée sur des cotations fictives serait pire que pas de distribution.
          </li>
          <li>
            <span className="text-gray-300">Cohérence</span> : la probabilité de finir au-dessus d'un seuil ne peut pas remonter quand le seuil monte ; les
            cotations bruitées qui violent cette règle sont corrigées au minimum (régression isotone). Rien n'est extrapolé hors des seuils cotés.
          </li>
          <li>Ce sont des probabilités de marché, pas des prévisions.</li>
        </ul>
      </section>

      {ladders.error && !ladders.data ? (
        <p className="text-sm text-red-400">Erreur : {ladders.error}</p>
      ) : !ladders.data ? (
        <p className="text-sm text-gray-500">Lecture des marchés d'issue et de leurs carnets…</p>
      ) : usable.length === 0 ? (
        <p className="text-sm text-gray-400">
          Aucune échelle n'est assez liquide pour en tirer une distribution fiable en ce moment. Les marchés d'issue sont récents ; les échelles
          apparaîtront ici dès que leurs carnets se rempliront.
        </p>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {usable.map(({ ladder, dist }) => (
            <LadderCard key={`${ladder.underlying}|${ladder.expiry}`} ladder={ladder} dist={dist!} price={mids[ladder.underlying]} />
          ))}
        </div>
      )}

      {rejected.length > 0 && (
        <section className="rounded-lg border border-bg-border bg-bg-panel p-3">
          <button onClick={() => setShowRejected((s) => !s)} className="text-xs text-gray-400 hover:text-white">
            {showRejected ? "▾" : "▸"} {rejected.length} échelle{rejected.length > 1 ? "s" : ""} écartée{rejected.length > 1 ? "s" : ""} faute de liquidité
          </button>
          {showRejected && (
            <ul className="mt-2 space-y-1 text-xs text-gray-500">
              {rejected.map(({ ladder }) => (
                <li key={`${ladder.underlying}|${ladder.expiry}`}>
                  <span className="text-gray-300">{assetName(ladder.underlying)}</span> · échéance {fmtExpiry(ladder.expiry)} ·{" "}
                  {ladder.points.filter(isLiquid).length}/{ladder.points.length} cotations liquides (2 minimum)
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </main>
  );
}

function LadderCard({ ladder, dist, price }: { ladder: Ladder; dist: Distribution; price: number | undefined }) {
  const now = useNow(60_000);
  const median = impliedMedian(dist);
  const above = price !== undefined ? probAbove(dist, price) : null;
  const k = dist.thresholds;
  const maxP = Math.max(...dist.buckets.map((b) => b.p), 0.01);

  // Prix hors de la plage cotée : on dit ce que la plage permet de dire.
  let headline: ReactNode;
  if (above !== null && price !== undefined) {
    headline = (
      <>
        <span className="font-semibold text-white">{Math.round(above * 100)} %</span> de chances de finir au-dessus du prix actuel
      </>
    );
  } else if (price !== undefined && price < k[0]) {
    headline = (
      <>
        <span className="font-semibold text-white">{Math.round((1 - dist.survival[0]) * 100)} %</span> de chances de finir sous {fmtPrice(k[0])}, le
        plus bas seuil coté (le prix actuel est en dessous)
      </>
    );
  } else if (price !== undefined) {
    headline = (
      <>
        <span className="font-semibold text-white">{Math.round(dist.survival[dist.survival.length - 1] * 100)} %</span> de chances de finir au-dessus
        de {fmtPrice(k[k.length - 1])}, le plus haut seuil coté (le prix actuel est au-dessus)
      </>
    );
  }

  return (
    <section className="rounded-lg border border-bg-border bg-bg-panel p-4">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-base font-semibold text-white">
          {assetName(ladder.underlying)}
          {ladder.underlying.includes(":") && (
            <span className="ml-1.5 rounded bg-purple-500/15 px-1 py-px align-middle text-[10px] font-medium uppercase text-purple-300">
              {ladder.underlying.split(":")[0]}
            </span>
          )}
        </h3>
        <span className="text-xs text-gray-500">
          échéance {fmtExpiry(ladder.expiry)} · dans {fmtIn(ladder.expiry - now)}
        </span>
        <span className="ml-auto text-sm text-gray-400">
          prix {price !== undefined ? <LivePrice value={price} className="text-gray-100" /> : "—"}
        </span>
      </div>

      <p className="mb-1 text-sm text-gray-300">{headline}</p>
      <p className="mb-3 text-xs text-gray-500">
        Médiane implicite : {median !== null ? <span className="text-gray-200">{fmtPrice(median)}</span> : "hors de la plage cotée"} ·{" "}
        {dist.used}/{dist.total} cotations retenues
        <InfoTip text="Prix pour lequel le marché donne autant de chances de finir au-dessus qu'en dessous. Calculé par interpolation entre les deux seuils qui l'encadrent." />
      </p>

      <div className="space-y-1">
        {[...dist.buckets].reverse().map((b, i) => {
          const containsPrice =
            price !== undefined && (b.from === null || price >= b.from) && (b.to === null || price < b.to);
          return (
            <div key={i} className="flex items-center gap-2 text-xs">
              <span className={`w-36 shrink-0 text-right tabular-nums ${containsPrice ? "font-semibold text-blue-300" : "text-gray-500"}`}>
                {b.from === null ? `< ${fmtPrice(b.to!)}` : b.to === null ? `≥ ${fmtPrice(b.from)}` : `${fmtPrice(b.from)} – ${fmtPrice(b.to)}`}
              </span>
              <div className="h-3 flex-1 rounded-sm bg-bg-hover">
                <div className={`h-full rounded-sm ${containsPrice ? "bg-blue-500/80" : "bg-gray-500/60"}`} style={{ width: `${(b.p / maxP) * 100}%` }} />
              </div>
              <span className="w-10 shrink-0 text-right tabular-nums text-gray-300">{Math.round(b.p * 100)} %</span>
            </div>
          );
        })}
      </div>

      <details className="mt-3 text-xs text-gray-500">
        <summary className="cursor-pointer hover:text-gray-300">Cotations par seuil</summary>
        <table className="mt-2 w-full">
          <thead>
            <tr className="text-gray-600">
              <th className="text-left font-normal">Seuil</th>
              <th className="text-right font-normal">P(au-dessus)</th>
              <th className="text-right font-normal">Achat / vente</th>
              <th className="text-right font-normal">Retenue</th>
            </tr>
          </thead>
          <tbody>
            {ladder.points.map((p) => (
              <tr key={p.coin}>
                <td className="tabular-nums text-gray-300">{fmtPrice(p.threshold)}</td>
                <td className="text-right tabular-nums">{Number.isFinite(quote(p)) ? `${Math.round(quote(p) * 100)} %` : "—"}</td>
                <td className="text-right tabular-nums">
                  {p.bid != null ? p.bid.toFixed(3) : "—"} / {p.ask != null ? p.ask.toFixed(3) : "—"}
                </td>
                <td className={`text-right ${isLiquid(p) ? "text-green-400" : "text-gray-600"}`}>{isLiquid(p) ? "oui" : "non"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}

const assetName = (id: string) => (id.includes(":") ? id.split(":")[1] : id);

function fmtExpiry(ms: number): string {
  return new Date(ms).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";
}

function fmtIn(ms: number): string {
  const h = Math.max(0, Math.floor(ms / 3600_000));
  if (h < 48) return `${h} h`;
  return `${Math.floor(h / 24)} j`;
}
