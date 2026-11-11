/**
 * Simulateur de scénarios BTC — logique pure.
 *
 * Question posée : « si le BTC fait +20 % en 6 mois, quel portefeuille
 * long/short aurait le plus de chances de bien se comporter ? »
 *
 * Méthode, choisie après étude hors échantillon sur l'historique réel :
 *
 * 1. Pour chaque token, deux mesures de son comportement passé face au BTC,
 *    sur des rendements log hebdomadaires :
 *    - le BÊTA (52 dernières semaines) : de combien il bouge quand le BTC bouge ;
 *    - la DÉRIVE (tout l'historique) : ce qu'il gagne ou perd par semaine à
 *      BTC inchangé.
 * 2. Ces mesures ne se reproduisent qu'en partie. Constaté : seuls ~30 % de
 *    l'écart de bêta entre tokens se retrouvent à 1–3 mois, presque rien à
 *    6 mois, et la persistance de la dérive dépend de l'époque. Projeter le
 *    passé tel quel annoncerait des gains 3 à 5 fois trop élevés. Chaque
 *    mesure est donc RAMENÉE VERS LA MOYENNE des tokens, dans la proportion
 *    qui s'est réellement vérifiée (`calibrate`, par « walk-forward » : à
 *    chaque date passée, on n'utilise que ce qui était connu à cette date).
 * 3. Le portefeuille retenu prend les N tokens au rendement attendu le plus
 *    élevé à l'achat, les N plus faibles à la vente.
 * 4. La fourchette d'incertitude ne sort pas d'un modèle : c'est l'écart
 *    réellement constaté entre l'annonce et le résultat quand on a appliqué
 *    la même méthode dans le passé, en connaissant la performance du BTC —
 *    pondéré vers les périodes où le BTC a fait une performance comparable.
 *
 * Limites assumées : connaître la performance du BTC est l'hypothèse la plus
 * forte ; funding, frais et glissement sont ignorés ; les positions sont
 * tenues sans rééquilibrage ni stop (un short peut perdre plus de 100 %).
 */

// --- Données ------------------------------------------------------------------------
export interface RawCoin {
  /** Nom du perp. */
  c: string;
  /** Rendements log hebdomadaires en points de base, du plus ancien au plus récent. */
  r: number[];
  /** Liquidité par semaine : 10 × log10(volume quotidien moyen sur 30 j) ; −1 = inconnue. */
  v?: number[];
  /** Retiré de la cote. */
  x?: boolean;
  /** Semaines manquantes à la fin (retrait avant la dernière semaine). */
  e?: number;
}

export interface RawMatrix {
  ts: number;
  anchor_day: number;
  weeks: number;
  coins: RawCoin[];
}

export const LIQ_UNKNOWN = -1;
const LIQ_NONE = -2;
export const BTC = "BTC";
/** Fenêtre d'estimation du bêta. */
export const BETA_WEEKS = 52;
/** Historique minimal pour qu'un token soit mesuré. */
export const MIN_WEEKS = 26;
/** Une date passée n'est testée que si au moins autant de tokens y sont mesurables. */
export const MIN_COINS = 15;

export const HORIZONS = [
  { weeks: 4, label: "1 mois" },
  { weeks: 13, label: "3 mois" },
  { weeks: 26, label: "6 mois" },
] as const;

/** Code de liquidité d'un volume quotidien en dollars (60 = 1 M$). */
export const liqCode = (usdPerDay: number): number => (usdPerDay <= 1 ? 0 : Math.round(10 * Math.log10(usdPerDay)));
export const liqUsd = (code: number): number | null => (code < 0 ? null : Math.pow(10, code / 10));

interface Prefix {
  n: Float64Array;
  sx: Float64Array;
  sy: Float64Array;
  sxx: Float64Array;
  sxy: Float64Array;
}

export interface Matrix {
  weeks: number;
  anchorDay: number;
  ts: number;
  names: string[];
  delisted: boolean[];
  /** [token][semaine] : rendement log, NaN hors cotation. */
  ret: Float64Array[];
  liq: Int16Array[];
  btc: number;
  /** Sommes cumulées par token : une régression sur n'importe quelle fenêtre en temps constant. */
  pre: Prefix[];
}

export function parseMatrix(raw: RawMatrix): Matrix {
  const W = raw.weeks;
  const btc = raw.coins.findIndex((c) => c.c === BTC);
  if (btc < 0) throw new Error("BTC absent de la matrice");
  const ret: Float64Array[] = [];
  const liq: Int16Array[] = [];
  for (const c of raw.coins) {
    const r = new Float64Array(W).fill(NaN);
    const l = new Int16Array(W).fill(LIQ_NONE);
    const end = W - (c.e ?? 0);
    const start = end - c.r.length;
    for (let k = 0; k < c.r.length; k++) {
      if (start + k < 0) continue;
      r[start + k] = c.r[k] / 10_000;
      l[start + k] = c.v?.[k] ?? LIQ_UNKNOWN;
    }
    ret.push(r);
    liq.push(l);
  }
  const x = ret[btc];
  const pre = ret.map((y) => {
    const p: Prefix = {
      n: new Float64Array(W + 1),
      sx: new Float64Array(W + 1),
      sy: new Float64Array(W + 1),
      sxx: new Float64Array(W + 1),
      sxy: new Float64Array(W + 1),
    };
    for (let w = 0; w < W; w++) {
      const ok = !Number.isNaN(y[w]) && !Number.isNaN(x[w]);
      p.n[w + 1] = p.n[w] + (ok ? 1 : 0);
      p.sx[w + 1] = p.sx[w] + (ok ? x[w] : 0);
      p.sy[w + 1] = p.sy[w] + (ok ? y[w] : 0);
      p.sxx[w + 1] = p.sxx[w] + (ok ? x[w] * x[w] : 0);
      p.sxy[w + 1] = p.sxy[w] + (ok ? x[w] * y[w] : 0);
    }
    return p;
  });
  return { weeks: W, anchorDay: raw.anchor_day, ts: raw.ts, names: raw.coins.map((c) => c.c), delisted: raw.coins.map((c) => !!c.x), ret, liq, btc, pre };
}

// --- Mesures par token ---------------------------------------------------------------
function ols(p: Prefix, lo: number, hi: number): { n: number; a: number; b: number } | null {
  const n = p.n[hi] - p.n[lo];
  if (n < 3) return null;
  const sx = p.sx[hi] - p.sx[lo];
  const sy = p.sy[hi] - p.sy[lo];
  const den = n * (p.sxx[hi] - p.sxx[lo]) - sx * sx;
  if (!(den > 1e-12)) return null;
  const b = (n * (p.sxy[hi] - p.sxy[lo]) - sx * sy) / den;
  return { n, a: (sy - b * sx) / n, b };
}

export interface Fit {
  /** Dérive hebdomadaire (log) à BTC inchangé, sur tout l'historique connu. */
  drift: number;
  /** Bêta face au BTC sur les 52 dernières semaines connues. */
  beta: number;
  /** Semaines d'historique. */
  weeks: number;
}

/** Mesures d'un token avec les seules données antérieures à la semaine `s`. */
export function fitAt(m: Matrix, i: number, s: number): Fit | null {
  if (s < 1 || Number.isNaN(m.ret[i][s - 1])) return null;
  const beta = ols(m.pre[i], Math.max(0, s - BETA_WEEKS), s);
  if (!beta || beta.n < MIN_WEEKS) return null;
  const all = ols(m.pre[i], 0, s);
  if (!all) return null;
  return { drift: all.a, beta: beta.b, weeks: all.n };
}

// --- Passé rejoué (walk-forward) -------------------------------------------------------
export interface PastWindow {
  /** Première semaine de la période testée. */
  s: number;
  /** Rendement log du BTC sur la période. */
  R: number;
  idx: number[];
  drift: number[];
  beta: number[];
  /** Rendement log réalisé de chaque token sur la période. */
  real: number[];
}

/**
 * Pour chaque date passée : les mesures de chaque token connues À CETTE DATE,
 * et ce qu'il a fait ensuite sur l'horizon. Un token retiré de la cote en
 * cours de période garde son dernier cours (position soldée).
 */
export function buildPanel(m: Matrix, H: number, minLiq: number): PastWindow[] {
  const out: PastWindow[] = [];
  const x = m.pre[m.btc];
  for (let s = 1; s + H <= m.weeks; s++) {
    if (x.n[s + H] - x.n[s] !== H) continue;
    const R = x.sy[s + H] - x.sy[s];
    const w: PastWindow = { s, R, idx: [], drift: [], beta: [], real: [] };
    for (let i = 0; i < m.names.length; i++) {
      if (i === m.btc || Number.isNaN(m.ret[i][s])) continue;
      const l = m.liq[i][s - 1];
      if (l !== LIQ_UNKNOWN && l < minLiq) continue;
      const f = fitAt(m, i, s);
      if (!f) continue;
      w.idx.push(i);
      w.drift.push(f.drift);
      w.beta.push(f.beta);
      w.real.push(m.pre[i].sy[s + H] - m.pre[i].sy[s]);
    }
    if (w.idx.length >= MIN_COINS) out.push(w);
  }
  return out;
}

const mean = (v: number[]): number => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);
const clamp01 = (x: number): number => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);

export interface Calibration {
  /** Part de l'écart de bêta (à la moyenne des tokens) qui s'est retrouvée. */
  kappa: number;
  /** Part de l'écart de dérive qui s'est retrouvée. */
  lambda: number;
  /** Part de la dérive MOYENNE des altcoins face au BTC qui s'est retrouvée. */
  gamma: number;
  /** Valeurs brutes avant bornage à [0, 1]. */
  raw: { kappa: number; lambda: number; gamma: number };
  windows: number;
}

/**
 * Quelle part du passé s'est reproduite ? Régression empilée, sur toutes les
 * dates passées, de l'écart de rendement réalisé (à la moyenne de la période)
 * sur l'écart de bêta × performance du BTC et sur l'écart de dérive × durée.
 * Un coefficient de 1 voudrait dire « le passé se répète à l'identique ».
 * Bornés à [0, 1] : un coefficient négatif (effet inversé) n'est pas exploité.
 */
export function calibrate(panel: PastWindow[], H: number): Calibration {
  let s11 = 0, s12 = 0, s22 = 0, s1y = 0, s2y = 0, gNum = 0, gDen = 0;
  for (const w of panel) {
    const bBar = mean(w.beta), aBar = mean(w.drift), yBar = mean(w.real);
    for (let k = 0; k < w.idx.length; k++) {
      const x1 = (w.beta[k] - bBar) * w.R;
      const x2 = (w.drift[k] - aBar) * H;
      const y = w.real[k] - yBar;
      s11 += x1 * x1;
      s12 += x1 * x2;
      s22 += x2 * x2;
      s1y += x1 * y;
      s2y += x2 * y;
    }
    // Niveau : rendement moyen des altcoins au-delà de leur bêta moyen × BTC.
    const excess = yBar - bBar * w.R;
    const predicted = aBar * H;
    gNum += excess * predicted;
    gDen += predicted * predicted;
  }
  const det = s11 * s22 - s12 * s12;
  const raw = {
    kappa: det > 1e-18 ? (s22 * s1y - s12 * s2y) / det : 0,
    lambda: det > 1e-18 ? (s11 * s2y - s12 * s1y) / det : 0,
    gamma: gDen > 1e-18 ? gNum / gDen : 0,
  };
  return { kappa: clamp01(raw.kappa), lambda: clamp01(raw.lambda), gamma: clamp01(raw.gamma), raw, windows: panel.length };
}

// --- Modèle courant -------------------------------------------------------------------
export interface Token {
  coin: string;
  isBtc: boolean;
  /** Mesures brutes. */
  beta: number;
  drift: number;
  /** Mesures retenues, ramenées vers la moyenne des tokens. */
  betaAdj: number;
  driftAdj: number;
  weeks: number;
  liq: number;
}

export interface Model {
  H: number;
  cal: Calibration;
  tokens: Token[];
  meanBeta: number;
  meanDrift: number;
}

function adjust(beta: number, drift: number, bBar: number, aBar: number, cal: Calibration): { betaAdj: number; driftAdj: number } {
  return { betaAdj: bBar + cal.kappa * (beta - bBar), driftAdj: cal.gamma * aBar + cal.lambda * (drift - aBar) };
}

/** Tokens négociables aujourd'hui, avec leurs mesures calibrées. BTC compris (bêta 1, dérive 0 par définition). */
export function currentModel(m: Matrix, H: number, minLiq: number, cal: Calibration): Model {
  const s = m.weeks;
  const rows: { i: number; f: Fit }[] = [];
  for (let i = 0; i < m.names.length; i++) {
    if (i === m.btc || m.delisted[i]) continue;
    const l = m.liq[i][s - 1];
    if (l < minLiq) continue; // liquidité inconnue ou insuffisante
    const f = fitAt(m, i, s);
    if (f) rows.push({ i, f });
  }
  const meanBeta = mean(rows.map((r) => r.f.beta));
  const meanDrift = mean(rows.map((r) => r.f.drift));
  const tokens: Token[] = rows.map(({ i, f }) => ({
    coin: m.names[i],
    isBtc: false,
    beta: f.beta,
    drift: f.drift,
    ...adjust(f.beta, f.drift, meanBeta, meanDrift, cal),
    weeks: f.weeks,
    liq: m.liq[i][s - 1],
  }));
  tokens.push({ coin: BTC, isBtc: true, beta: 1, drift: 0, betaAdj: 1, driftAdj: 0, weeks: m.pre[m.btc].n[s], liq: m.liq[m.btc][s - 1] });
  return { H, cal, tokens, meanBeta, meanDrift };
}

/** Rendement log attendu d'un token si le BTC fait `R` (log) sur l'horizon. */
export const expectedLog = (t: Token, R: number, H: number): number => t.driftAdj * H + t.betaAdj * R;

export const toLog = (pct: number): number => Math.log(1 + pct);
export const toPct = (log: number): number => Math.exp(log) - 1;

// --- Portefeuille ---------------------------------------------------------------------
export interface Spec {
  /** Positions de chaque côté. */
  n: number;
  /** Part du capital à l'achat (0,5 = équilibre 50/50). */
  longShare: number;
  allowBtc: boolean;
}

/** Les n rendements attendus les plus élevés (du meilleur au moins bon) et les n plus faibles (du pire au moins mauvais), sans recouvrement. */
export function selectLegs(mu: number[], n: number): { longs: number[]; shorts: number[] } {
  const order = mu.map((_, k) => k).sort((a, b) => mu[b] - mu[a]);
  const k = Math.max(0, Math.min(n, Math.floor(order.length / 2)));
  return { longs: order.slice(0, k), shorts: order.slice(order.length - k).reverse() };
}

/** P&L en part du capital total, positions tenues jusqu'au bout, rendements log par position. */
export function portfolioPnl(longLogs: number[], shortLogs: number[], longShare: number): number {
  const leg = (v: number[]) => (v.length ? mean(v.map(toPct)) : 0);
  return longShare * leg(longLogs) - (1 - longShare) * leg(shortLogs);
}

export interface Leg {
  token: Token;
  /** Rendement attendu (simple) dans le scénario. */
  ret: number;
}

export interface Portfolio {
  longs: Leg[];
  shorts: Leg[];
  /** P&L annoncé par le modèle (rendements médians). */
  announced: number;
}

export function pickPortfolio(model: Model, R: number, spec: Spec): Portfolio {
  const cands = model.tokens.filter((t) => spec.allowBtc || !t.isBtc);
  const mu = cands.map((t) => expectedLog(t, R, model.H));
  const { longs, shorts } = selectLegs(mu, spec.n);
  const L = spec.longShare > 0 ? longs : [];
  const S = spec.longShare < 1 ? shorts : [];
  return {
    longs: L.map((k) => ({ token: cands[k], ret: toPct(mu[k]) })),
    shorts: S.map((k) => ({ token: cands[k], ret: toPct(mu[k]) })),
    announced: portfolioPnl(L.map((k) => mu[k]), S.map((k) => mu[k]), spec.longShare),
  };
}

/** P&L annoncé d'un portefeuille FIGÉ pour une autre performance du BTC : sa sensibilité au scénario. */
export function payoff(p: Portfolio, R: number, H: number, longShare: number): number {
  return portfolioPnl(p.longs.map((l) => expectedLog(l.token, R, H)), p.shorts.map((l) => expectedLog(l.token, R, H)), longShare);
}

// --- Ce que la méthode aurait donné dans le passé --------------------------------------
export interface PastResult {
  s: number;
  R: number;
  announced: number;
  realized: number;
  /** Corrélation de rang entre rendements attendus et réalisés des tokens. */
  ic: number;
}

function ranks(v: number[]): number[] {
  const order = v.map((_, k) => k).sort((a, b) => v[a] - v[b]);
  const r = new Array<number>(v.length);
  for (let k = 0; k < order.length; ) {
    let j = k;
    while (j + 1 < order.length && v[order[j + 1]] === v[order[k]]) j++;
    for (let q = k; q <= j; q++) r[order[q]] = (k + j) / 2;
    k = j + 1;
  }
  return r;
}

export function spearman(a: number[], b: number[]): number {
  const n = a.length;
  if (n < 3) return 0;
  const ra = ranks(a), rb = ranks(b);
  const ma = mean(ra), mb = mean(rb);
  let num = 0, da = 0, db = 0;
  for (let k = 0; k < n; k++) {
    num += (ra[k] - ma) * (rb[k] - mb);
    da += (ra[k] - ma) ** 2;
    db += (rb[k] - mb) ** 2;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

/**
 * Rejoue la méthode à chaque date passée, EN SUPPOSANT CONNUE la performance
 * du BTC sur la période : même calibration, même nombre de positions, même
 * équilibre. L'écart entre annoncé et réalisé est l'erreur réelle du modèle.
 */
export function backtest(panel: PastWindow[], H: number, cal: Calibration, spec: Spec): PastResult[] {
  return panel.map((w) => {
    const bBar = mean(w.beta), aBar = mean(w.drift);
    const mu = w.idx.map((_, k) => {
      const { betaAdj, driftAdj } = adjust(w.beta[k], w.drift[k], bBar, aBar, cal);
      return driftAdj * H + betaAdj * w.R;
    });
    const ic = spearman(mu, w.real);
    const real = [...w.real];
    if (spec.allowBtc) {
      mu.push(w.R);
      real.push(w.R);
    }
    const { longs, shorts } = selectLegs(mu, spec.n);
    const L = spec.longShare > 0 ? longs : [];
    const S = spec.longShare < 1 ? shorts : [];
    return {
      s: w.s,
      R: w.R,
      announced: portfolioPnl(L.map((k) => mu[k]), S.map((k) => mu[k]), spec.longShare),
      realized: portfolioPnl(L.map((k) => real[k]), S.map((k) => real[k]), spec.longShare),
      ic,
    };
  });
}

export interface PastSummary {
  windows: number;
  /** Périodes indépendantes approximatives (les fenêtres glissantes se recouvrent). */
  independent: number;
  winRate: number;
  medianRealized: number;
  meanRealized: number;
  meanAnnounced: number;
  worst: number;
  meanIc: number;
}

export function summarize(past: PastResult[], H: number): PastSummary | null {
  if (past.length === 0) return null;
  const r = past.map((p) => p.realized).sort((a, b) => a - b);
  const span = past[past.length - 1].s - past[0].s + H;
  return {
    windows: past.length,
    independent: Math.max(1, Math.floor(span / H)),
    winRate: r.filter((v) => v > 0).length / r.length,
    medianRealized: r[Math.floor(r.length / 2)],
    meanRealized: mean(r),
    meanAnnounced: mean(past.map((p) => p.announced)),
    worst: r[0],
    meanIc: mean(past.map((p) => p.ic)),
  };
}

// --- Fourchette : erreurs passées, pondérées vers les périodes comparables ---------------
export function weightedQuantile(values: number[], weights: number[], q: number): number {
  const order = values.map((_, k) => k).sort((a, b) => values[a] - values[b]);
  const total = weights.reduce((a, b) => a + b, 0);
  if (!(total > 0) || order.length === 0) return NaN;
  let cum = 0;
  for (const k of order) {
    cum += weights[k];
    if (cum >= q * total) return values[k];
  }
  return values[order[order.length - 1]];
}

export interface Band {
  /** P&L médian attendu : l'annonce corrigée de l'erreur médiane passée. */
  median: number;
  low: number;
  high: number;
  probGain: number;
  /** Nombre équivalent de périodes glissantes comparables qui portent la fourchette. */
  effective: number;
  /**
   * Épisodes réellement indépendants parmi elles, approximativement : des
   * périodes glissantes de H semaines décalées d'une semaine se recouvrent
   * presque entièrement, il en faut ~H pour faire un épisode distinct.
   */
  independent: number;
  /** Peu d'épisodes passés ressemblent au scénario : fourchette fragile. */
  thin: boolean;
}

export const THIN_BELOW = 8;
/** Sous ce nombre d'épisodes indépendants comparables, la fourchette est dite fragile. */
export const THIN_EPISODES = 3;

/**
 * Fourchette autour d'une annonce pour un BTC à `R` : quantiles des erreurs
 * passées (réalisé − annoncé), chaque période pesant d'autant plus que le BTC
 * y a fait une performance proche de `R` (noyau gaussien).
 */
export function band(past: PastResult[], R: number, announced: number, H: number): Band | null {
  if (past.length < THIN_BELOW) return null;
  const Rs = past.map((p) => p.R);
  const m = mean(Rs);
  const sd = Math.sqrt(mean(Rs.map((v) => (v - m) ** 2)));
  const h = Math.max(0.5 * sd, 0.04);
  const w = past.map((p) => Math.exp(-0.5 * ((p.R - R) / h) ** 2));
  const errors = past.map((p) => p.realized - p.announced);
  const sw = w.reduce((a, b) => a + b, 0);
  const sw2 = w.reduce((a, b) => a + b * b, 0);
  if (!(sw > 1e-12)) {
    // Scénario très loin de tout ce qui s'est produit : toutes les périodes, à poids égal.
    const flat = past.map(() => 1);
    return {
      median: announced + weightedQuantile(errors, flat, 0.5),
      low: announced + weightedQuantile(errors, flat, 0.1),
      high: announced + weightedQuantile(errors, flat, 0.9),
      probGain: errors.filter((e) => announced + e > 0).length / errors.length,
      effective: 0,
      independent: 0,
      thin: true,
    };
  }
  const effective = (sw * sw) / sw2;
  return {
    median: announced + weightedQuantile(errors, w, 0.5),
    low: announced + weightedQuantile(errors, w, 0.1),
    high: announced + weightedQuantile(errors, w, 0.9),
    probGain: errors.reduce((acc, e, k) => acc + (announced + e > 0 ? w[k] : 0), 0) / sw,
    effective,
    independent: effective / H,
    thin: effective < THIN_BELOW || effective / H < THIN_EPISODES,
  };
}
