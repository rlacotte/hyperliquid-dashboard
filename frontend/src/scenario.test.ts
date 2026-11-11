import { describe, expect, it } from "vitest";
import {
  backtest,
  band,
  buildPanel,
  calibrate,
  currentModel,
  expectedLog,
  fitAt,
  liqCode,
  liqUsd,
  LIQ_UNKNOWN,
  MIN_COINS,
  parseMatrix,
  payoff,
  pickPortfolio,
  portfolioPnl,
  selectLegs,
  spearman,
  summarize,
  toLog,
  toPct,
  weightedQuantile,
  type Calibration,
  type PastResult,
  type PastWindow,
  type RawCoin,
  type RawMatrix,
} from "./scenario";

/** Générateur déterministe : les tests ne dépendent d'aucun hasard. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296 - 0.5;
  };
}

const W = 120;
const bp = (x: number) => Math.round(x * 10_000);

/** BTC : rendements hebdomadaires pseudo-aléatoires d'environ ±4 %. */
function btcReturns(seed = 1): number[] {
  const r = rng(seed);
  return Array.from({ length: W }, () => r() * 0.16);
}

/** Token suivant y = dérive + bêta × BTC (+ bruit), sur les `weeks` dernières semaines. */
function coin(name: string, x: number[], drift: number, beta: number, opts: { weeks?: number; noise?: number; seed?: number; liq?: number; x?: boolean; e?: number } = {}): RawCoin {
  const weeks = opts.weeks ?? W;
  const e = opts.e ?? 0;
  const r = rng(opts.seed ?? name.length * 7919);
  const end = W - e;
  const out: number[] = [];
  for (let w = end - weeks; w < end; w++) out.push(bp(drift + beta * x[w] + (opts.noise ?? 0) * r()));
  return { c: name, r: out, v: out.map(() => opts.liq ?? 65), ...(opts.x ? { x: true } : {}), ...(e ? { e } : {}) };
}

function matrix(coins: RawCoin[], x = btcReturns()): RawMatrix {
  return { ts: 0, anchor_day: 20_000, weeks: W, coins: [{ c: "BTC", r: x.map(bp), v: x.map(() => 90) }, ...coins] };
}

describe("lecture de la matrice", () => {
  it("aligne chaque token sur la fin, en tenant compte des semaines manquantes après un retrait", () => {
    const x = btcReturns();
    const m = parseMatrix(matrix([coin("NEW", x, 0, 1, { weeks: 10 }), coin("DEAD", x, 0, 1, { weeks: 20, e: 5, x: true })], x));
    const iNew = m.names.indexOf("NEW"), iDead = m.names.indexOf("DEAD");
    expect(Number.isNaN(m.ret[iNew][W - 11])).toBe(true);
    expect(m.ret[iNew][W - 10]).toBeCloseTo(x[W - 10], 3);
    expect(Number.isNaN(m.ret[iDead][W - 5])).toBe(true); // après le retrait
    expect(m.ret[iDead][W - 6]).toBeCloseTo(x[W - 6], 3);
    expect(m.delisted[iDead]).toBe(true);
  });

  it("codes de liquidité", () => {
    expect(liqCode(1e6)).toBe(60);
    expect(liqCode(5e6)).toBe(67);
    expect(liqUsd(60)).toBeCloseTo(1e6, 0);
    expect(liqUsd(LIQ_UNKNOWN)).toBeNull();
  });
});

describe("mesures par token", () => {
  const x = btcReturns();
  const m = parseMatrix(matrix([coin("ALT", x, -0.01, 1.5), coin("YOUNG", x, 0, 1, { weeks: 20 })], x));

  it("retrouve la dérive et le bêta d'un token qui suit exactement le BTC", () => {
    const f = fitAt(m, m.names.indexOf("ALT"), W)!;
    expect(f.beta).toBeCloseTo(1.5, 2);
    expect(f.drift).toBeCloseTo(-0.01, 3);
    expect(f.weeks).toBe(W);
  });

  it("pas de mesure sous 26 semaines d'historique", () => {
    expect(fitAt(m, m.names.indexOf("YOUNG"), W)).toBeNull();
  });

  it("n'utilise que le passé : changer les semaines suivantes ne change rien", () => {
    const x2 = btcReturns();
    const altered = coin("ALT", x2, -0.01, 1.5);
    for (let w = 80; w < W; w++) altered.r[w] = 5000; // +50 % par semaine après la semaine 80
    const m2 = parseMatrix(matrix([altered], x2));
    const before = fitAt(m, m.names.indexOf("ALT"), 80)!;
    const after = fitAt(m2, m2.names.indexOf("ALT"), 80)!;
    expect(after.beta).toBeCloseTo(before.beta, 9);
    expect(after.drift).toBeCloseTo(before.drift, 9);
  });
});

/** Univers assez large pour que les dates passées soient testables. */
function universe(x: number[], n = MIN_COINS + 3, extra: RawCoin[] = []): RawMatrix {
  const coins = Array.from({ length: n }, (_, k) => coin(`C${k}`, x, -0.004 + 0.0005 * k, 0.6 + 0.1 * k, { noise: 0.01, seed: 100 + k }));
  return matrix([...coins, ...extra], x);
}

describe("passé rejoué", () => {
  const x = btcReturns();

  it("liquidité : inconnue acceptée, insuffisante écartée", () => {
    const m = parseMatrix(universe(x, MIN_COINS, [coin("THIN", x, 0, 1, { liq: 50 }), coin("OLD", x, 0, 1, { liq: LIQ_UNKNOWN })]));
    const panel = buildPanel(m, 4, 60);
    const w = panel[panel.length - 1];
    const names = w.idx.map((i) => m.names[i]);
    expect(names).toContain("OLD");
    expect(names).not.toContain("THIN");
    expect(names).not.toContain("BTC");
  });

  it("un token retiré en cours de période garde son dernier cours", () => {
    const dead = coin("DEAD", x, 0, 1, { weeks: W - 2, e: 2, x: true });
    const m = parseMatrix(universe(x, MIN_COINS, [dead]));
    const H = 4;
    const w = buildPanel(m, H, 0).find((p) => p.s === W - H)!; // période couvrant les 2 semaines manquantes
    const k = w.idx.indexOf(m.names.indexOf("DEAD"));
    expect(k).toBeGreaterThanOrEqual(0);
    expect(w.real[k]).toBeCloseTo(x[W - 4] + x[W - 3], 3); // seules les 2 semaines cotées comptent
  });

  it("pas de date testée sous le nombre minimal de tokens", () => {
    const m = parseMatrix(universe(x, MIN_COINS - 1));
    expect(buildPanel(m, 4, 0)).toHaveLength(0);
  });

  it("le rendement du BTC de la période est la somme de ses semaines", () => {
    const m = parseMatrix(universe(x));
    const w = buildPanel(m, 13, 0).find((p) => p.s === 60)!;
    expect(w.R).toBeCloseTo(x.slice(60, 73).reduce((a, b) => a + b, 0), 3);
  });
});

describe("calibration", () => {
  /** Panel où le réalisé reproduit une part connue du passé. */
  function synthetic(kappa: number, lambda: number, gamma: number, H = 13): PastWindow[] {
    const r = rng(42);
    return Array.from({ length: 40 }, (_, w) => {
      const R = r() * 0.8;
      const beta = Array.from({ length: 20 }, () => 1.3 + r());
      const drift = Array.from({ length: 20 }, () => -0.005 + r() * 0.02);
      const bBar = beta.reduce((a, b) => a + b) / 20, aBar = drift.reduce((a, b) => a + b) / 20;
      const real = beta.map((b, k) => bBar * R + gamma * aBar * H + kappa * (b - bBar) * R + lambda * (drift[k] - aBar) * H);
      return { s: w + 1, R, idx: beta.map((_, k) => k), drift, beta, real };
    });
  }

  it("retrouve la part du passé qui s'est reproduite", () => {
    const cal = calibrate(synthetic(0.3, 0.15, 0.5), 13);
    expect(cal.kappa).toBeCloseTo(0.3, 6);
    expect(cal.lambda).toBeCloseTo(0.15, 6);
    expect(cal.gamma).toBeCloseTo(0.5, 6);
    expect(cal.windows).toBe(40);
  });

  it("un effet inversé n'est pas exploité : borné à zéro, valeur brute conservée", () => {
    const cal = calibrate(synthetic(-0.2, 1.4, -0.3), 13);
    expect(cal.kappa).toBe(0);
    expect(cal.lambda).toBe(1);
    expect(cal.gamma).toBe(0);
    expect(cal.raw.kappa).toBeCloseTo(-0.2, 6);
    expect(cal.raw.lambda).toBeCloseTo(1.4, 6);
  });

  it("sans donnée : coefficients nuls", () => {
    const cal = calibrate([], 13);
    expect([cal.kappa, cal.lambda, cal.gamma]).toEqual([0, 0, 0]);
  });
});

const CAL: Calibration = { kappa: 0.5, lambda: 0.5, gamma: 1, raw: { kappa: 0.5, lambda: 0.5, gamma: 1 }, windows: 100 };

describe("modèle courant", () => {
  const x = btcReturns();
  const raw = universe(x, MIN_COINS, [
    coin("GONE", x, 0, 1, { x: true }),
    coin("THIN", x, 0, 1, { liq: 40 }),
    coin("NOVOL", x, 0, 1, { liq: LIQ_UNKNOWN }),
    coin("YOUNG", x, 0, 1, { weeks: 12 }),
  ]);
  const m = parseMatrix(raw);
  const model = currentModel(m, 13, 60, CAL);

  it("seuls les tokens négociables, liquides et assez anciens ; BTC en plus", () => {
    const names = model.tokens.map((t) => t.coin);
    for (const out of ["GONE", "THIN", "NOVOL", "YOUNG"]) expect(names).not.toContain(out);
    expect(names).toContain("BTC");
    expect(model.tokens).toHaveLength(MIN_COINS + 1);
  });

  it("BTC : bêta 1 et dérive nulle par définition", () => {
    const btc = model.tokens.find((t) => t.isBtc)!;
    expect([btc.betaAdj, btc.driftAdj]).toEqual([1, 0]);
    expect(toPct(expectedLog(btc, toLog(0.2), 13))).toBeCloseTo(0.2, 9);
  });

  it("bêta et dérive ramenés vers la moyenne dans la proportion calibrée", () => {
    const t = model.tokens.find((k) => k.coin === "C0")!;
    expect(t.betaAdj).toBeCloseTo(model.meanBeta + 0.5 * (t.beta - model.meanBeta), 9);
    expect(t.driftAdj).toBeCloseTo(model.meanDrift + 0.5 * (t.drift - model.meanDrift), 9);
  });
});

describe("portefeuille", () => {
  it("les meilleurs à l'achat, les pires à la vente, jamais le même token des deux côtés", () => {
    expect(selectLegs([0.1, 0.5, -0.3, 0.2, -0.1], 2)).toEqual({ longs: [1, 3], shorts: [2, 4] });
    expect(selectLegs([0.1, 0.5, -0.3], 5)).toEqual({ longs: [1], shorts: [2] }); // univers trop petit : on réduit
    expect(selectLegs([], 3)).toEqual({ longs: [], shorts: [] });
  });

  it("P&L en part du capital selon l'équilibre", () => {
    const up = toLog(0.2), down = toLog(-0.1);
    expect(portfolioPnl([up], [down], 0.5)).toBeCloseTo(0.5 * 0.2 + 0.5 * 0.1, 9);
    expect(portfolioPnl([up], [down], 1)).toBeCloseTo(0.2, 9);
    expect(portfolioPnl([up], [down], 0)).toBeCloseTo(0.1, 9);
    // Un short qui triple coûte 200 % de sa jambe : plus que la mise.
    expect(portfolioPnl([], [toLog(2)], 0)).toBeCloseTo(-2, 9);
  });

  const x = btcReturns();
  const model = currentModel(parseMatrix(universe(x)), 13, 0, CAL);

  it("BTC en hausse : forts bêtas à l'achat ; en baisse : l'inverse", () => {
    const noDrift = { ...model, tokens: model.tokens.map((t) => ({ ...t, driftAdj: 0 })) };
    const spec = { n: 3, longShare: 0.5, allowBtc: false };
    const up = pickPortfolio(noDrift, toLog(0.3), spec);
    const down = pickPortfolio(noDrift, toLog(-0.3), spec);
    const maxBeta = Math.max(...noDrift.tokens.filter((t) => !t.isBtc).map((t) => t.betaAdj));
    expect(up.longs[0].token.betaAdj).toBe(maxBeta);
    expect(down.shorts[0].token.betaAdj).toBe(maxBeta);
    expect(up.announced).toBeGreaterThan(0);
    expect(down.announced).toBeGreaterThan(0);
  });

  it("BTC écarté sur demande ; jambe vide quand l'équilibre est à 100/0", () => {
    const p = pickPortfolio(model, toLog(0.2), { n: 3, longShare: 1, allowBtc: false });
    expect(p.shorts).toHaveLength(0);
    expect(p.longs.some((l) => l.token.isBtc)).toBe(false);
    expect(p.announced).toBeCloseTo(p.longs.reduce((s, l) => s + l.ret, 0) / 3, 9);
  });

  it("la sensibilité d'un portefeuille figé repasse par son annonce au scénario d'origine", () => {
    const R = toLog(0.2);
    const p = pickPortfolio(model, R, { n: 3, longShare: 0.5, allowBtc: true });
    expect(payoff(p, R, model.H, 0.5)).toBeCloseTo(p.announced, 9);
    expect(payoff(p, toLog(-0.4), model.H, 0.5)).not.toBeCloseTo(p.announced, 3);
  });
});

describe("la méthode rejouée dans le passé", () => {
  it("annoncé et réalisé par période, BTC candidat si autorisé", () => {
    const w: PastWindow = { s: 10, R: 0.2, idx: [0, 1, 2, 3], drift: [0, 0, 0, 0], beta: [2, 1.5, 1, 0.5], real: [0.5, 0.2, 0.1, -0.2] };
    const cal: Calibration = { ...CAL, kappa: 1, lambda: 0, gamma: 0 };
    const [r] = backtest([w], 4, cal, { n: 1, longShare: 0.5, allowBtc: false });
    // Long bêta 2 (annoncé e^0,4), short bêta 0,5 (annoncé e^0,1).
    expect(r.announced).toBeCloseTo(0.5 * (Math.exp(0.4) - 1) - 0.5 * (Math.exp(0.1) - 1), 9);
    expect(r.realized).toBeCloseTo(0.5 * (Math.exp(0.5) - 1) - 0.5 * (Math.exp(-0.2) - 1), 9);
    expect(r.ic).toBeCloseTo(1, 9);
    // BTC (rendement = scénario 0,2) entre bêta 1 (0,2) et … : il peut devenir une jambe.
    const [down] = backtest([{ ...w, R: -0.2 }], 4, { ...cal, kappa: 0 }, { n: 1, longShare: 0.5, allowBtc: true });
    // κ = 0 : tous les alts au bêta moyen 1,25 → −0,25 ; le BTC (−0,2) est le meilleur long.
    expect(down.announced).toBeCloseTo(0.5 * (Math.exp(-0.2) - 1) - 0.5 * (Math.exp(-0.25) - 1), 9);
  });

  it("résumé : taux de réussite, pire cas, périodes indépendantes", () => {
    const past: PastResult[] = Array.from({ length: 26 }, (_, k) => ({ s: k + 1, R: 0, announced: 0.05, realized: k < 20 ? 0.1 : -0.3, ic: 0.2 }));
    const s = summarize(past, 13)!;
    expect(s.windows).toBe(26);
    expect(s.independent).toBe(2); // 26 fenêtres glissantes de 13 semaines couvrent 38 semaines
    expect(s.winRate).toBeCloseTo(20 / 26, 9);
    expect(s.worst).toBe(-0.3);
    expect(summarize([], 13)).toBeNull();
  });

  it("corrélation de rang", () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1, 9);
    expect(spearman([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1, 9);
    expect(spearman([1, 1, 1], [1, 2, 3])).toBe(0);
  });
});

describe("fourchette", () => {
  it("quantile pondéré", () => {
    expect(weightedQuantile([1, 2, 3, 4], [1, 1, 1, 1], 0.5)).toBe(2);
    expect(weightedQuantile([1, 2, 3, 4], [0, 0, 0, 1], 0.1)).toBe(4);
    expect(Number.isNaN(weightedQuantile([], [], 0.5))).toBe(true);
  });

  /** Passé où l'erreur dépend du régime : +10 % quand le BTC montait, −10 % quand il baissait. */
  const past: PastResult[] = Array.from({ length: 60 }, (_, k) => {
    const R = k < 30 ? 0.2 + 0.002 * k : -0.2 - 0.002 * (k - 30);
    const err = k < 30 ? 0.1 : -0.1;
    return { s: k + 1, R, announced: 0.05, realized: 0.05 + err, ic: 0 };
  });

  it("pèse d'abord les périodes où le BTC a fait une performance comparable", () => {
    const up = band(past, 0.22, 0.05, 4)!;
    const down = band(past, -0.22, 0.05, 4)!;
    expect(up.median).toBeCloseTo(0.15, 6);
    expect(up.probGain).toBeGreaterThan(0.95);
    expect(down.median).toBeCloseTo(-0.05, 6);
    expect(down.probGain).toBeLessThan(0.05);
    expect(up.thin).toBe(false);
    expect(up.independent).toBeCloseTo(up.effective / 4, 9);
  });

  it("des périodes glissantes longues comptent pour peu d'épisodes : fragile", () => {
    // Les mêmes 30 périodes comparables, mais de 26 semaines chacune : à peine plus d'un épisode distinct.
    expect(band(past, 0.22, 0.05, 26)!.thin).toBe(true);
  });

  it("scénario jamais vu : la fourchette est signalée comme fragile", () => {
    expect(band(past, 3, 0.05, 4)!.thin).toBe(true);
  });

  it("trop peu de passé : pas de fourchette", () => {
    expect(band(past.slice(0, 5), 0.2, 0.05, 4)).toBeNull();
  });
});
