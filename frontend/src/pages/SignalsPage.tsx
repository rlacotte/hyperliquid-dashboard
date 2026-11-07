import { useMemo, useState, type ReactNode } from "react";
import { api } from "../api";
import { usePolling } from "../hooks/usePolling";
import { signalLabel, verdict, MIN_CLUSTERS, MIN_COINS, type HorizonKey, type TrackGroup } from "../signals";
import { colorPct } from "../format";
import { InfoTip } from "../components/InfoTip";

const HORIZONS: HorizonKey[] = ["1h", "4h", "24h"];

const pct = (v: number | null | undefined, digits = 2) =>
  v === null || v === undefined ? "—" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(digits)} %`;
const share = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${Math.round(v * 100)} %`);

export function SignalsPage() {
  const track = usePolling(() => api.trackRecord(), 300_000);
  const [h, setH] = useState<HorizonKey>("4h");

  const groups = useMemo(
    () => [...(track.data?.groups ?? [])].sort((a, b) => (b.horizons[h]?.n ?? 0) - (a.horizons[h]?.n ?? 0)),
    [track.data, h]
  );

  return (
    <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-3 md:p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold text-white">Track record des signaux</h1>
        <div className="flex rounded-lg border border-bg-border bg-bg-panel p-0.5 text-sm">
          {HORIZONS.map((k) => (
            <button key={k} onClick={() => setH(k)} className={`rounded-md px-3 py-1 ${h === k ? "bg-blue-600 text-white" : "text-gray-400 hover:text-white"}`}>
              +{k}
            </button>
          ))}
        </div>
        {track.data && (
          <span className="text-xs text-gray-500">
            {track.data.outcomes.toLocaleString("fr-FR")} alertes mesurées · {track.data.lookback_days} derniers jours
          </span>
        )}
      </div>

      <section className="max-w-5xl rounded-lg border border-bg-border bg-bg-panel p-4 text-xs leading-relaxed text-gray-400">
        <p className="mb-1.5 text-sm text-gray-200">Ce qu'il s'est réellement passé après chaque alerte émise par ce dashboard.</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <span className="text-gray-300">Sans regard vers le futur</span> : le prix de départ est l'ouverture de la première bougie de 15 min qui suit
            l'alerte — celui auquel on aurait pu agir en la recevant.
          </li>
          <li>
            <span className="text-gray-300">Relatif au BTC</span> : un jour où tout baisse, tous les signaux baissiers paraissent excellents. Le verdict compare
            donc le coin au BTC sur la même fenêtre.
          </li>
          <li>
            <span className="text-gray-300">Prudence statistique</span> : les alertes d'un même coin le même jour décrivent un seul épisode — le verdict porte
            sur ces épisodes (grappes coin × jour), pas sur le nombre brut d'alertes. Aucun verdict sous {MIN_CLUSTERS} épisodes ni sous {MIN_COINS} coins
            distincts ; « significatif » signifie un test binomial à z ≥ 2 sur les épisodes.
          </li>
          <li>
            <span className="text-gray-300">Témoin (24 h)</span> : les alertes se déclenchent surtout sur des altcoins volatils, qui peuvent sous-performer
            le BTC en général. Le verdict compare donc les épisodes d'alerte aux jours ordinaires des mêmes coins sur la même période (test de deux
            proportions). Les horizons 1 h et 4 h n'ont pas encore de témoin : leur verdict ne compare qu'au BTC et le signale.
          </li>
          <li>Source : bougies Hyperliquid, indépendantes des interruptions passées de notre collecte. Rattrapage progressif de l'historique.</li>
        </ul>
      </section>

      {track.error && !track.data ? (
        <p className="text-sm text-gray-400">Track record indisponible pour l'instant.</p>
      ) : !track.data ? (
        <p className="text-sm text-gray-500">Chargement…</p>
      ) : groups.length === 0 ? (
        <p className="text-sm text-gray-400">Le rattrapage de l'historique vient de commencer : les premiers résultats apparaissent au fil des cycles.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-bg-border">
          <table className="w-full text-sm">
            <thead className="bg-bg-panel text-xs text-gray-400">
              <tr>
                <Th align="left">Signal</Th>
                <Th secondary help="Alertes de ce type dont l'horizon choisi est mesuré.">Cas</Th>
                <Th secondary help="Part des cas où le prix a monté sur l'horizon.">Hausse</Th>
                <Th secondary>Moyen</Th>
                <Th secondary help="Plus robuste que la moyenne aux mouvements extrêmes.">Médian</Th>
                <Th help="Crypto : rendement du coin moins celui du BTC sur la même fenêtre. HIP-3 : rendement brut (pas de référence commune à des actions, de l'or et des devises).">vs réf.</Th>
                <Th secondary help="Crypto : part des cas où le coin a fait mieux que le BTC. HIP-3 : part des cas en hausse.">Bat la réf.</Th>
                <Th secondary help="Épisodes indépendants : alertes regroupées par coin et par jour. C'est l'effectif réel du test.">Épisodes</Th>
                <Th secondary help="Horizon 24 h : part des jours ORDINAIRES où ces mêmes coins ont battu le BTC sur la même période. C'est la référence du verdict.">
                  Témoin
                </Th>
                <Th align="left" last>
                  Verdict
                </Th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <GroupRow key={`${g.segment ?? "crypto"}|${g.criterion}|${g.sign}`} g={g} h={h} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

function GroupRow({ g, h }: { g: TrackGroup; h: HorizonKey }) {
  const s = g.horizons[h] ?? { n: 0 };
  const v = verdict(s, g.coins, g.benchmark === undefined ? "BTC" : g.benchmark);
  const tone =
    v.tone === "positive" ? "text-green-400" : v.tone === "negative" ? "text-red-400" : v.tone === "neutral" ? "text-gray-300" : "text-gray-600";
  return (
    <tr className="border-t border-bg-border">
      <td className="px-3 py-2">
        <div className="font-medium text-gray-100">
          {signalLabel(g.criterion, g.sign)}
          {g.segment === "hip3" && (
            <span
              className="ml-1.5 rounded bg-purple-500/15 px-1 py-px align-middle text-[10px] font-medium text-purple-300"
              title="Actions, indices, matières premières, devises : mesuré en rendement brut, sans référence commune."
            >
              HIP-3
            </span>
          )}
        </div>
        <div className="text-[11px] text-gray-600">
          {g.alerts} alertes · {g.coins} {g.segment === "hip3" ? "marchés" : "coins"}
        </div>
      </td>
      <td className="hidden sm:table-cell px-3 py-2 text-right tabular-nums text-gray-300">{s.n || "—"}</td>
      <td className="hidden sm:table-cell px-3 py-2 text-right tabular-nums text-gray-300">{share(s.p_up)}</td>
      <td className={`hidden sm:table-cell px-3 py-2 text-right tabular-nums ${s.mean === undefined ? "text-gray-600" : colorPct(s.mean)}`}>{pct(s.mean)}</td>
      <td className={`hidden sm:table-cell px-3 py-2 text-right tabular-nums ${s.median === undefined ? "text-gray-600" : colorPct(s.median)}`}>{pct(s.median)}</td>
      <td className={`px-3 py-2 text-right font-semibold tabular-nums ${s.mean_vs_btc == null ? "text-gray-600" : colorPct(s.mean_vs_btc)}`}>
        {pct(s.mean_vs_btc)}
      </td>
      <td className="hidden sm:table-cell px-3 py-2 text-right tabular-nums text-gray-300">{share(s.p_beat_btc)}</td>
      <td className="hidden sm:table-cell px-3 py-2 text-right tabular-nums text-gray-400">{s.n_clusters ?? "—"}</td>
      <td className="hidden sm:table-cell px-3 py-2 text-right tabular-nums text-gray-400" title={s.baseline_n ? `${s.baseline_n} jours ordinaires` : undefined}>
        {s.baseline_p_beat !== undefined ? share(s.baseline_p_beat) : "—"}
      </td>
      <td className={`px-3 py-2 text-xs ${tone}`}>
        {v.significant && <span className="mr-1">●</span>}
        {v.text}
      </td>
    </tr>
  );
}

function Th({
  children,
  align = "right",
  help,
  last,
  secondary,
}: {
  children: ReactNode;
  align?: "left" | "right";
  help?: string;
  last?: boolean;
  /** Masquée sous 640 px : sur téléphone, signal / vs réf. / verdict. */
  secondary?: boolean;
}) {
  return (
    <th className={`whitespace-nowrap px-3 py-2 font-medium ${align === "left" ? "text-left" : "text-right"} ${secondary ? "hidden sm:table-cell" : ""}`}>
      {children}
      {help && <InfoTip text={help} align={last ? "right" : "center"} />}
    </th>
  );
}
