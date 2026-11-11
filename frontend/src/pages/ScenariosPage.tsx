import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../api";
import { hl, type Market } from "../hl/client";
import { useHlPoll, useLiveMidsAll } from "../hl/hooks";
import { usePolling } from "../hooks/usePolling";
import { fmtUsdLarge, fundingApr } from "../format";
import { InfoTip } from "../components/InfoTip";
import { AssetDetail } from "../components/AssetDetail";
import {
  backtest,
  band,
  BETA_WEEKS,
  buildPanel,
  calibrate,
  currentModel,
  expectedLog,
  HORIZONS,
  liqCode,
  liqUsd,
  MIN_WEEKS,
  parseMatrix,
  payoff,
  pickPortfolio,
  summarize,
  toLog,
  toPct,
  weightedQuantile,
  type Band,
  type Leg,
  type Spec,
  type Token,
} from "../scenario";

/** Plage du curseur selon l'horizon : au-delà, aucune période passée n'y ressemble. */
const RANGE: Record<number, { min: number; max: number; presets: number[] }> = {
  4: { min: -40, max: 60, presets: [-20, -10, 0, 10, 20, 40] },
  13: { min: -50, max: 100, presets: [-30, -10, 0, 20, 50, 80] },
  26: { min: -60, max: 150, presets: [-40, -20, 0, 20, 50, 100] },
};

const BALANCES: [number, string][] = [
  [1, "100 / 0"],
  [0.7, "70 / 30"],
  [0.5, "50 / 50"],
  [0.3, "30 / 70"],
  [0, "0 / 100"],
];

const LIQUIDITY: [number, string][] = [
  [0, "toutes"],
  [1e6, "≥ 1 M$"],
  [5e6, "≥ 5 M$"],
  [20e6, "≥ 20 M$"],
];

const pc = (x: number, digits = 0): string => {
  const v = Math.abs(x * 100).toFixed(digits);
  return Number(v) === 0 ? "0 %" : `${x >= 0 ? "+" : "−"}${v} %`;
};
/** Une décimale sous 10 %, aucune au-delà : +6,4 % mais +53 %. */
const pcAuto = (x: number): string => pc(x, Math.abs(x) < 0.0995 ? 1 : 0);
const tone = (x: number): string => (x > 0.0005 ? "text-green-400" : x < -0.0005 ? "text-red-400" : "text-gray-300");

export function ScenariosPage() {
  const data = usePolling(() => api.scenarios(), 30 * 60_000);
  const perps = useHlPoll(() => hl.perps(""), 120_000);

  const [H, setH] = useState(26);
  const [btcPct, setBtcPct] = useState(20);
  const [longShare, setLongShare] = useState(0.5);
  const [n, setN] = useState(5);
  const [minUsd, setMinUsd] = useState(1e6);
  const [allowBtc, setAllowBtc] = useState(true);
  const [selected, setSelected] = useState<Market | null>(null);

  const range = RANGE[H];
  const pct = Math.max(range.min, Math.min(range.max, btcPct));
  const R = toLog(pct / 100);
  const minLiq = liqCode(minUsd);
  const horizonLabel = HORIZONS.find((h) => h.weeks === H)!.label;

  const matrix = useMemo(() => (data.data ? parseMatrix(data.data) : null), [data.data]);
  // Tout ce qui ne dépend pas du curseur est calculé une fois par réglage.
  const panel = useMemo(() => (matrix ? buildPanel(matrix, H, minLiq) : []), [matrix, H, minLiq]);
  const cal = useMemo(() => calibrate(panel, H), [panel, H]);
  const model = useMemo(() => (matrix ? currentModel(matrix, H, minLiq, cal) : null), [matrix, H, minLiq, cal]);
  const spec: Spec = useMemo(() => ({ n, longShare, allowBtc }), [n, longShare, allowBtc]);
  const past = useMemo(() => backtest(panel, H, cal, spec), [panel, H, cal, spec]);
  const summary = useMemo(() => summarize(past, H), [past, H]);

  const portfolio = useMemo(() => (model ? pickPortfolio(model, R, spec) : null), [model, R, spec]);
  const result = useMemo(() => (portfolio ? band(past, R, portfolio.announced, H) : null), [past, R, portfolio, H]);

  const curve = useMemo(() => {
    if (!portfolio) return [];
    const steps = 50;
    return Array.from({ length: steps + 1 }, (_, k) => {
      const x = range.min + ((range.max - range.min) * k) / steps;
      const announced = payoff(portfolio, toLog(x / 100), H, longShare);
      return { x, announced, band: band(past, toLog(x / 100), announced, H) };
    });
  }, [portfolio, past, range, H, longShare]);

  // Chaque période passée, reportée autour de la courbe : l'annonce de CE
  // portefeuille pour le BTC de l'époque, plus l'erreur commise alors.
  const dots = useMemo(
    () => (portfolio ? past.map((p) => ({ x: toPct(p.R) * 100, y: payoff(portfolio, p.R, H, longShare) + (p.realized - p.announced) })) : []),
    [portfolio, past, H, longShare]
  );

  const btcHistory = useMemo(() => {
    if (past.length < 20) return null;
    const rs = past.map((p) => p.R);
    const flat = rs.map(() => 1);
    return { low: toPct(weightedQuantile(rs, flat, 0.05)), high: toPct(weightedQuantile(rs, flat, 0.95)) };
  }, [past]);

  const perpByName = useMemo(() => new Map((perps.data ?? []).map((m) => [m.name, m])), [perps.data]);

  // Portage : ce que coûte ou rapporte le funding ACTUEL sur l'horizon (indicatif).
  const carry = useMemo(() => {
    if (!portfolio || perpByName.size === 0) return null;
    const legApr = (legs: Leg[]): number | null => {
      const v = legs.flatMap((l) => {
        const f = perpByName.get(l.token.coin)?.funding;
        return f === null || f === undefined ? [] : [fundingApr(f)];
      });
      return v.length === legs.length && v.length > 0 ? v.reduce((a, b) => a + b, 0) / v.length : legs.length === 0 ? 0 : null;
    };
    const l = legApr(portfolio.longs), s = legApr(portfolio.shorts);
    if (l === null || s === null) return null;
    // Funding positif : les longs paient, les shorts encaissent.
    return (-longShare * l + (1 - longShare) * s) * (H / 52);
  }, [portfolio, perpByName, longShare, H]);

  const inPortfolio = useMemo(() => {
    const m = new Map<string, "long" | "short">();
    for (const l of portfolio?.longs ?? []) m.set(l.token.coin, "long");
    for (const s of portfolio?.shorts ?? []) m.set(s.token.coin, "short");
    return m;
  }, [portfolio]);

  const ranked = useMemo(
    () => (model ? model.tokens.map((t) => ({ t, ret: toPct(expectedLog(t, R, H)) })).sort((a, b) => b.ret - a.ret) : []),
    [model, R, H]
  );

  return (
    <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-3 md:p-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="text-lg font-semibold text-white">Scénarios BTC</h1>
        <span className="text-xs text-gray-500">Quel portefeuille long/short selon la performance du BTC, d'après le comportement passé des tokens ?</span>
      </div>

      {data.error && !data.data ? (
        <p className="text-sm text-gray-400">
          {data.error.includes("503") ? "Historique en cours de constitution côté serveur : le simulateur sera disponible dans l'heure." : `Erreur : ${data.error}`}
        </p>
      ) : !matrix || !model || !portfolio ? (
        <p className="text-sm text-gray-500">Chargement de l'historique…</p>
      ) : (
        <>
          {/* --- Scénario -------------------------------------------------------- */}
          <section className="shrink-0 rounded-lg border border-bg-border bg-bg-panel p-3 md:p-4">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <span className="text-sm text-gray-300">Si le BTC fait</span>
              <span className={`min-w-[5.5rem] text-center text-2xl font-bold tabular-nums ${tone(pct)}`}>{pc(pct / 100)}</span>
              <span className="text-sm text-gray-300">en</span>
              <Segmented value={H} onChange={setH} options={HORIZONS.map((h) => [h.weeks, h.label])} strong />
            </div>
            <input
              type="range"
              min={range.min}
              max={range.max}
              step={1}
              value={pct}
              onChange={(e) => setBtcPct(Number(e.target.value))}
              aria-label="Performance supposée du BTC"
              className="mt-3 w-full accent-blue-500"
            />
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
              {range.presets.map((p) => (
                <button
                  key={p}
                  onClick={() => setBtcPct(p)}
                  className={`rounded px-2 py-0.5 tabular-nums ${pct === p ? "bg-blue-600 text-white" : "bg-bg-base text-gray-400 hover:text-white"}`}
                >
                  {pc(p / 100)}
                </button>
              ))}
              {btcHistory && (
                <span className="ml-auto text-gray-500">
                  Sur {horizonLabel}, le BTC a fait entre {pc(btcHistory.low)} et {pc(btcHistory.high)} neuf fois sur dix depuis 2021.
                </span>
              )}
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-bg-border pt-3 text-xs">
              <label className="flex flex-wrap items-center gap-1.5 text-gray-400">
                <span className="whitespace-nowrap">Long / short</span>
                <Segmented value={longShare} onChange={setLongShare} options={BALANCES} />
                <InfoTip text="Part du capital placée à l'achat et à la vente. 50 / 50 : autant des deux côtés, le portefeuille est neutre en dollars (pas forcément en bêta)." />
              </label>
              <label className="flex flex-wrap items-center gap-1.5 text-gray-400">
                <span className="whitespace-nowrap">Positions par côté</span>
                <Segmented value={n} onChange={setN} options={[[3, "3"], [5, "5"], [10, "10"]]} />
                <InfoTip text="Plus il y a de positions, moins le résultat dépend d'un seul token : dans le passé, 10 positions ont nettement réduit les pires pertes." />
              </label>
              <label className="flex flex-wrap items-center gap-1.5 text-gray-400">
                <span className="whitespace-nowrap">Liquidité</span>
                <Segmented value={minUsd} onChange={setMinUsd} options={LIQUIDITY} />
                <InfoTip text="Volume quotidien moyen sur 30 jours. Le filtre s'applique aux tokens proposés ET au passé rejoué : la calibration change avec lui." />
              </label>
              <label className="flex cursor-pointer items-center gap-1.5 text-gray-400">
                <input type="checkbox" checked={allowBtc} onChange={(e) => setAllowBtc(e.target.checked)} className="accent-blue-500" />
                BTC autorisé comme position
              </label>
            </div>
          </section>

          {/* --- Portefeuille retenu --------------------------------------------- */}
          <section className="shrink-0 rounded-lg border border-bg-border bg-bg-panel p-3 md:p-4">
            <h2 className="mb-3 text-sm font-medium text-gray-200">
              Portefeuille le plus favorable selon le modèle
              <span className="ml-2 text-xs font-normal text-gray-500">
                BTC {pc(pct / 100)} en {horizonLabel} · {model.tokens.length} tokens éligibles
              </span>
            </h2>
            <div className="grid gap-3 md:grid-cols-2">
              <LegCard title="Achat" share={longShare} legs={portfolio.longs} side="long" onOpen={(c) => setSelected(perpByName.get(c) ?? null)} />
              <LegCard title="Vente à découvert" share={1 - longShare} legs={portfolio.shorts} side="short" onOpen={(c) => setSelected(perpByName.get(c) ?? null)} />
            </div>
            <Outcome result={result} announced={portfolio.announced} carry={carry} horizonLabel={horizonLabel} />
          </section>

          {/* --- Sensibilité ----------------------------------------------------- */}
          <section className="shrink-0 rounded-lg border border-bg-border bg-bg-panel p-3 md:p-4">
            <h2 className="mb-1 flex items-center text-sm font-medium text-gray-200">
              Et si le BTC fait autre chose ?
              <InfoTip text="Le même portefeuille, figé, pour chaque performance possible du BTC. Une courbe plate : le résultat ne dépend pas de votre hypothèse sur le BTC. Une courbe pentue : le portefeuille est en réalité un pari sur le BTC." />
            </h2>
            <p className="mb-2 text-xs text-gray-500">
              En abscisse, la performance du BTC ; en ordonnée, le résultat de ce portefeuille. Trait : médiane attendue. Zone : 8 cas sur 10. Points : les périodes passées, reportées
              autour de la courbe avec l'erreur commise à l'époque.
            </p>
            <PayoffChart curve={curve} dots={dots} marker={pct} xMin={range.min} xMax={range.max} />
          </section>

          {/* --- Le passé rejoué -------------------------------------------------- */}
          <section className="shrink-0 rounded-lg border border-bg-border bg-bg-panel p-3 text-xs leading-relaxed text-gray-400 md:p-4">
            <h2 className="mb-2 text-sm font-medium text-gray-200">Ce que la méthode aurait donné dans le passé</h2>
            {summary ? (
              <ul className="list-disc space-y-1 pl-5">
                <li>
                  Rejouée sur <span className="text-gray-200">{summary.windows} périodes glissantes</span> de {horizonLabel} (≈ {summary.independent}{" "}
                  indépendantes), <span className="text-gray-200">en supposant connue la performance du BTC</span> et avec les seules données disponibles à
                  chaque date : gagnante <span className="text-gray-200">{Math.round(summary.winRate * 100)} % du temps</span>, résultat médian{" "}
                  <span className={tone(summary.medianRealized)}>{pcAuto(summary.medianRealized)}</span>, pire période{" "}
                  <span className="text-red-400">{pcAuto(summary.worst)}</span>.
                </li>
                <li>
                  Classement des tokens : corrélation de rang <span className="text-gray-200">{summary.meanIc.toFixed(2)}</span> entre attendu et réalisé (0 =
                  hasard, 1 = parfait). Le modèle aide, sans plus.
                </li>
                <li>
                  Part du passé qui s'est réellement retrouvée sur {horizonLabel} : écart de bêta{" "}
                  <span className="text-gray-200">{Math.round(cal.kappa * 100)} %</span>, écart de dérive{" "}
                  <span className="text-gray-200">{Math.round(cal.lambda * 100)} %</span>, dérive moyenne des altcoins face au BTC{" "}
                  <span className="text-gray-200">{Math.round(cal.gamma * 100)} %</span>. Les mesures de chaque token sont réduites d'autant avant d'être
                  projetées.
                  {cal.kappa < 0.05 && (
                    <span className="text-amber-300/90">
                      {" "}
                      À cet horizon, l'écart de bêta entre tokens ne s'est pas retrouvé : l'hypothèse sur le BTC ne départage presque pas les altcoins entre
                      eux.
                    </span>
                  )}
                </li>
              </ul>
            ) : (
              <p>Pas assez d'historique avec ces réglages pour rejouer la méthode.</p>
            )}
          </section>

          {/* --- Tous les tokens --------------------------------------------------- */}
          <section className="shrink-0 overflow-x-auto rounded-lg border border-bg-border">
            <table className="w-full text-sm">
              <thead className="bg-bg-panel text-xs text-gray-400">
                <tr>
                  <Th align="left">Token</Th>
                  <Th help={`Rendement médian attendu si le BTC fait ${pc(pct / 100)} en ${horizonLabel}, mesures réduites comprises.`}>Attendu</Th>
                  <Th help={`De combien le token bouge quand le BTC bouge de 1 %, mesuré sur ${BETA_WEEKS} semaines → valeur retenue après réduction vers la moyenne (${model.meanBeta.toFixed(2)}).`}>
                    Bêta
                  </Th>
                  <Th secondary help="Gain ou perte annuel à BTC inchangé, mesuré sur tout l'historique → valeur retenue après réduction.">
                    Dérive / an
                  </Th>
                  <Th secondary>Historique</Th>
                  <Th secondary last help="Volume quotidien moyen sur 30 jours.">
                    Volume
                  </Th>
                </tr>
              </thead>
              <tbody>
                {ranked.map(({ t, ret }) => (
                  <TokenRow key={t.coin} t={t} ret={ret} side={inPortfolio.get(t.coin)} onOpen={() => setSelected(perpByName.get(t.coin) ?? null)} />
                ))}
              </tbody>
            </table>
          </section>

          <details className="max-w-5xl shrink-0 rounded-lg border border-bg-border bg-bg-panel p-3 text-xs leading-relaxed text-gray-400">
            <summary className="cursor-pointer text-gray-300">Méthode et limites</summary>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              <li>
                Pour chaque token, deux mesures sur ses rendements hebdomadaires : son <span className="text-gray-300">bêta</span> face au BTC ({BETA_WEEKS}{" "}
                dernières semaines) et sa <span className="text-gray-300">dérive</span> à BTC inchangé (tout l'historique, {MIN_WEEKS} semaines au moins).
              </li>
              <li>
                Le passé ne se reproduit qu'en partie. La méthode est donc rejouée à chaque date passée avec les seules données connues alors, et on mesure
                quelle part des écarts entre tokens s'est retrouvée. Chaque mesure est ramenée vers la moyenne dans cette proportion : sans cela, les gains
                annoncés seraient 3 à 5 fois trop élevés.
              </li>
              <li>
                Portefeuille : les tokens au rendement attendu le plus élevé à l'achat, les plus faibles à la vente, à parts égales dans chaque jambe, tenus
                jusqu'au bout sans rééquilibrage ni stop.
              </li>
              <li>
                Fourchette : l'écart réellement constaté entre l'annonce et le résultat dans les périodes passées, en pesant d'abord celles où le BTC a fait
                une performance comparable. Les périodes glissantes se recouvrent : leur nombre surestime l'information réellement disponible.
              </li>
              <li>
                <span className="text-gray-300">Ce que le modèle ignore</span> : funding (indiqué à part, au taux du jour), frais, glissement, liquidations,
                déblocages de tokens, actualité. Un short tenu sans stop peut perdre plus que sa mise — les pires périodes passées viennent presque toutes
                d'un token vendu qui s'est envolé.
              </li>
              <li>
                Avant l'ouverture d'Hyperliquid (2023), l'historique des grandes capitalisations est reconstitué : seuls les tokens encore vivants en 2023 y
                figurent, ce qui embellit un peu cette période. Les tokens retirés de la cote depuis sont bien inclus.
              </li>
              <li className="text-gray-300">
                Connaître la performance du BTC est l'hypothèse la plus forte de toutes. Ceci est un outil d'exploration, pas un conseil en investissement.
              </li>
            </ul>
          </details>
        </>
      )}

      {selected && <DetailWithLivePrice market={selected} onClose={() => setSelected(null)} />}
    </main>
  );
}

function DetailWithLivePrice({ market, onClose }: { market: Market; onClose: () => void }) {
  const mids = useLiveMidsAll([market.dex]);
  return <AssetDetail market={market} livePx={mids[market.id]} confluence={undefined} onClose={onClose} />;
}

// --- Résultat attendu -------------------------------------------------------------------
function Outcome({
  result,
  announced,
  carry,
  horizonLabel,
}: {
  result: Band | null;
  announced: number;
  carry: number | null;
  horizonLabel: string;
}) {
  if (!result) {
    return (
      <p className="mt-3 border-t border-bg-border pt-3 text-xs text-gray-400">
        Annonce du modèle : <span className={`font-semibold ${tone(announced)}`}>{pcAuto(announced)}</span> du capital. Pas assez d'historique avec ces
        réglages pour en donner la fourchette.
      </p>
    );
  }
  return (
    <div className="mt-3 border-t border-bg-border pt-3">
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
        <span className="text-sm text-gray-300">
          Résultat médian attendu <span className={`text-xl font-bold tabular-nums ${tone(result.median)}`}>{pcAuto(result.median)}</span>{" "}
          <span className="text-xs text-gray-500">du capital en {horizonLabel}</span>
        </span>
        <span className="text-sm text-gray-400">
          8 fois sur 10 entre <span className={`font-semibold tabular-nums ${tone(result.low)}`}>{pcAuto(result.low)}</span> et{" "}
          <span className={`font-semibold tabular-nums ${tone(result.high)}`}>{pcAuto(result.high)}</span>
        </span>
        <span className="text-sm text-gray-400">
          gain dans <span className="font-semibold text-gray-200">{Math.round(result.probGain * 100)} %</span> des cas comparables
        </span>
      </div>
      <p className="mt-1.5 text-xs text-gray-500">
        Fourchette tirée des périodes passées où le BTC a fait une performance proche : ≈ {Math.round(result.effective)} périodes glissantes, soit
        seulement ≈ {Math.max(1, Math.round(result.independent))} épisode{Math.round(result.independent) > 1 ? "s" : ""} indépendant
        {Math.round(result.independent) > 1 ? "s" : ""}. Annonce brute du modèle : {pcAuto(announced)}.
        {carry !== null && (
          <>
            {" "}
            Funding au taux du jour : <span className={tone(carry)}>{pcAuto(carry)}</span> sur la période (non inclus, il varie).
          </>
        )}
      </p>
      {result.thin && (
        <p className="mt-1.5 text-xs text-amber-300/90">
          Très peu d'épisodes passés ressemblent à ce scénario : la fourchette est fragile, à lire comme un ordre de grandeur.
        </p>
      )}
    </div>
  );
}

function LegCard({ title, share, legs, side, onOpen }: { title: string; share: number; legs: Leg[]; side: "long" | "short"; onOpen: (coin: string) => void }) {
  const color = side === "long" ? "text-green-400" : "text-red-400";
  return (
    <div className="rounded-md border border-bg-border bg-bg-base p-3">
      <h3 className={`mb-2 text-xs font-semibold uppercase tracking-wide ${color}`}>
        {title} <span className="font-normal normal-case tracking-normal text-gray-500">— {Math.round(share * 100)} % du capital</span>
      </h3>
      {legs.length === 0 ? (
        <p className="text-xs text-gray-500">Aucune position de ce côté avec cet équilibre.</p>
      ) : (
        <ul className="space-y-1">
          {legs.map((l) => (
            <li key={l.token.coin}>
              <button onClick={() => onOpen(l.token.coin)} className="flex w-full items-baseline gap-2 rounded px-1 py-0.5 text-left text-sm hover:bg-bg-hover">
                <span className="w-20 shrink-0 font-medium text-white">{l.token.coin}</span>
                <span className="min-w-0 truncate text-[11px] text-gray-500">
                  {l.token.isBtc ? "le scénario" : `bêta ${l.token.betaAdj.toFixed(2)}`} · {((share * 100) / legs.length).toFixed(0)} %
                </span>
                <span className={`ml-auto shrink-0 whitespace-nowrap tabular-nums ${tone(l.ret)}`} title="Rendement médian attendu du token dans ce scénario">
                  {pcAuto(l.ret)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// --- Courbe de sensibilité ----------------------------------------------------------------
interface CurvePoint {
  x: number;
  announced: number;
  band: Band | null;
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

function niceStep(range: number, target: number): number {
  const raw = range / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  return (norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10) * mag;
}

function PayoffChart({ curve, dots, marker, xMin, xMax }: { curve: CurvePoint[]; dots: { x: number; y: number }[]; marker: number; xMin: number; xMax: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const height = width < 480 ? 220 : 280;
  const M = { l: 44, r: 10, t: 10, b: 28 };

  const mid = (p: CurvePoint) => p.band?.median ?? p.announced;
  const values = curve.flatMap((p) => (p.band ? [p.band.low, p.band.high, p.band.median] : [p.announced])).filter(Number.isFinite);
  let yMin = Math.min(0, ...values), yMax = Math.max(0, ...values);
  const pad = Math.max(0.02, (yMax - yMin) * 0.08);
  yMin -= pad;
  yMax += pad;

  const sx = (x: number) => M.l + ((x - xMin) / (xMax - xMin)) * Math.max(1, width - M.l - M.r);
  const sy = (y: number) => M.t + ((yMax - y) / (yMax - yMin)) * (height - M.t - M.b);

  const banded = curve.filter((p) => p.band);
  const area = banded.length > 1 ? [...banded.map((p) => `${sx(p.x)},${sy(p.band!.high)}`), ...[...banded].reverse().map((p) => `${sx(p.x)},${sy(p.band!.low)}`)].join(" ") : "";
  const line = curve.map((p) => `${sx(p.x)},${sy(mid(p))}`).join(" ");

  const xStep = niceStep(xMax - xMin, width < 480 ? 5 : 9);
  const xTicks: number[] = [];
  for (let v = Math.ceil(xMin / xStep) * xStep; v <= xMax + 1e-9; v += xStep) xTicks.push(Math.round(v));
  const yStep = niceStep((yMax - yMin) * 100, 5) / 100;
  const yTicks: number[] = [];
  for (let v = Math.ceil(yMin / yStep) * yStep; v <= yMax + 1e-9; v += yStep) yTicks.push(v);

  const here = curve.reduce<CurvePoint | null>((best, p) => (best === null || Math.abs(p.x - marker) < Math.abs(best.x - marker) ? p : best), null);

  return (
    <div ref={ref} className="w-full">
      {width > 0 && curve.length > 1 && (
        <svg width={width} height={height} role="img" aria-label="Résultat du portefeuille selon la performance du BTC">
          {yTicks.map((v) => (
            <g key={`y${v}`}>
              <line x1={M.l} x2={width - M.r} y1={sy(v)} y2={sy(v)} stroke={Math.abs(v) < 1e-9 ? "#6b7280" : "#1f2937"} strokeDasharray={Math.abs(v) < 1e-9 ? "4 3" : undefined} />
              <text x={M.l - 6} y={sy(v) + 3.5} textAnchor="end" fontSize="10" fill="#6b7280">
                {pc(v)}
              </text>
            </g>
          ))}
          {xTicks.map((v) => (
            // La dernière graduation s'aligne à droite : centrée, elle sortirait du cadre.
            <text key={`x${v}`} x={sx(v)} y={height - 10} textAnchor={sx(v) > width - 24 ? "end" : "middle"} fontSize="10" fill="#6b7280">
              {pc(v / 100)}
            </text>
          ))}
          {area && <polygon points={area} fill="rgba(59,130,246,0.14)" />}
          {dots
            .filter((d) => d.x >= xMin && d.x <= xMax && d.y >= yMin && d.y <= yMax)
            .map((d, k) => (
              <circle key={k} cx={sx(d.x)} cy={sy(d.y)} r={1.6} fill="rgba(156,163,175,0.45)" />
            ))}
          <polyline points={line} fill="none" stroke="#60a5fa" strokeWidth={2} />
          {here && (
            <g>
              <line x1={sx(marker)} x2={sx(marker)} y1={M.t} y2={height - M.b} stroke="#f59e0b" strokeDasharray="3 3" />
              <circle cx={sx(marker)} cy={sy(mid(here))} r={4} fill="#f59e0b" />
            </g>
          )}
        </svg>
      )}
    </div>
  );
}

// --- Tableau des tokens ----------------------------------------------------------------------
function TokenRow({ t, ret, side, onOpen }: { t: Token; ret: number; side: "long" | "short" | undefined; onOpen: () => void }) {
  const usd = liqUsd(t.liq);
  const years = t.weeks / 52;
  return (
    <tr onClick={onOpen} className={`cursor-pointer border-t border-bg-border hover:bg-bg-hover ${side === "long" ? "bg-green-500/5" : side === "short" ? "bg-red-500/5" : ""}`}>
      <td className="px-2 py-1.5 sm:px-3">
        <span className="font-medium text-white">{t.coin}</span>
        {side && (
          <span className={`ml-2 rounded px-1 py-px text-[10px] font-semibold uppercase ${side === "long" ? "bg-green-500/15 text-green-300" : "bg-red-500/15 text-red-300"}`}>
            {side === "long" ? "achat" : "vente"}
          </span>
        )}
      </td>
      <Td className={`font-semibold ${tone(ret)}`}>{pcAuto(ret)}</Td>
      <Td>
        {t.isBtc ? (
          <span className="text-gray-500">1 par définition</span>
        ) : (
          <>
            <span className="text-gray-500">{t.beta.toFixed(2)} →</span> <span className="text-gray-200">{t.betaAdj.toFixed(2)}</span>
          </>
        )}
      </Td>
      <Td secondary>
        {t.isBtc ? (
          <span className="text-gray-600">—</span>
        ) : (
          <>
            <span className="text-gray-500">{pc(toPct(t.drift * 52))} →</span> <span className={tone(t.driftAdj)}>{pc(toPct(t.driftAdj * 52))}</span>
          </>
        )}
      </Td>
      <Td secondary className="text-gray-400">
        {years >= 1 ? `${years.toFixed(1)} ans` : `${t.weeks} sem.`}
      </Td>
      <Td secondary className="text-gray-400">
        {usd === null ? "—" : fmtUsdLarge(usd)}
      </Td>
    </tr>
  );
}

function Th({ children, align = "right", help, last, secondary }: { children: ReactNode; align?: "left" | "right"; help?: string; last?: boolean; secondary?: boolean }) {
  return (
    <th className={`whitespace-nowrap px-2 py-2 font-medium sm:px-3 ${align === "left" ? "text-left" : "text-right"} ${secondary ? "hidden sm:table-cell" : ""}`}>
      {children}
      {help && <InfoTip text={help} align={last ? "right" : "center"} />}
    </th>
  );
}

function Td({ children, className = "text-gray-300", secondary }: { children: ReactNode; className?: string; secondary?: boolean }) {
  return <td className={`whitespace-nowrap px-2 py-1.5 text-right tabular-nums sm:px-3 ${className} ${secondary ? "hidden sm:table-cell" : ""}`}>{children}</td>;
}

function Segmented<T extends number>({ value, onChange, options, strong }: { value: T; onChange: (v: T) => void; options: readonly (readonly [T, string])[]; strong?: boolean }) {
  return (
    <span className="inline-flex rounded-md border border-bg-border bg-bg-base p-0.5">
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          className={`whitespace-nowrap rounded px-2 py-0.5 ${strong ? "text-sm" : ""} ${
            value === v ? (strong ? "bg-blue-600 text-white" : "bg-bg-hover text-white") : "text-gray-500 hover:text-gray-200"
          }`}
        >
          {label}
        </button>
      ))}
    </span>
  );
}
