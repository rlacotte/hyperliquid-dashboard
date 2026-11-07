/**
 * Distribution de prix implicite tirée des marchés d'issue Hyperliquid.
 *
 * Un marché « binaryPrice » paie 1 si le cours d'un perp est AU-DESSUS d'un
 * seuil à une échéance (vérifié : à seuil croissant, la cotation du « Oui »
 * décroît — or à 3 600 $ ≈ 94 %, à 4 400 $ ≈ 8 %). Une échelle de seuils pour
 * une même échéance donne donc la fonction de survie S(K) = P(prix > K), dont
 * on déduit la probabilité de chaque tranche et la médiane implicite.
 *
 * Deux garde-fous, parce qu'une distribution fausse est pire que pas de
 * distribution :
 * - LIQUIDITÉ : une cotation sans carnet des deux côtés, ou à l'écart
 *   achat/vente trop large, est écartée (constaté : 0,69 / 0,93 sur l'argent,
 *   et des échelles BTC entières figées à 0,50 faute de carnet) ;
 * - MONOTONIE : S(K) ne peut pas remonter quand K augmente. Les cotations
 *   bruitées violent parfois cette règle ; une régression isotone (PAVA)
 *   la rétablit avec la plus petite correction possible.
 *
 * Ce sont des probabilités de marché (neutres au risque), pas des prévisions.
 */

export interface RawOutcome {
  outcome: number;
  name: string;
  description: string;
}

export interface LadderPoint {
  threshold: number;
  /** Cotation du côté « Oui » : "#" + outcome + "0". */
  coin: string;
  mid: number | null;
  bid?: number | null;
  ask?: number | null;
}

export interface Ladder {
  /** Identifiant du perp sous-jacent : "BTC", "xyz:GOLD"… */
  underlying: string;
  expiry: number;
  priceDescription: string;
  points: LadderPoint[];
}

/** Écart achat/vente maximal (en points de probabilité) pour retenir une cotation. */
export const MAX_SPREAD = 0.1;

export function parseDescription(desc: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of desc.split("|")) {
    const i = part.indexOf(":");
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

/** "20261130-2100" (UTC) → horodatage ms. */
export function parseExpiry(s: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(s);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
}

export const yesCoin = (outcome: number) => `#${outcome}0`;

/**
 * Regroupe les marchés binaryPrice par (sous-jacent, échéance). Seules les
 * échelles d'au moins `minPoints` seuils et non échues sont gardées : sous
 * trois points, il n'y a pas de distribution à lire.
 */
export function buildLadders(outcomes: RawOutcome[], mids: Record<string, string>, now: number, minPoints = 3): Ladder[] {
  const groups = new Map<string, Ladder>();
  for (const o of outcomes) {
    if (o.name !== "template:binaryPrice") continue;
    const d = parseDescription(o.description);
    const threshold = parseFloat(d.threshold);
    const expiry = d.time ? parseExpiry(d.time) : null;
    if (!d.perp || !Number.isFinite(threshold) || expiry === null || expiry <= now) continue;
    const key = `${d.perp}|${expiry}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { underlying: d.perp, expiry, priceDescription: d.priceDescription ?? "", points: [] }));
    const coin = yesCoin(o.outcome);
    const mid = mids[coin] !== undefined ? parseFloat(mids[coin]) : null;
    g.points.push({ threshold, coin, mid: mid !== null && Number.isFinite(mid) ? mid : null });
  }
  return [...groups.values()]
    .filter((g) => g.points.length >= minPoints)
    .map((g) => ({ ...g, points: [...g.points].sort((a, b) => a.threshold - b.threshold) }))
    .sort((a, b) => a.expiry - b.expiry || a.underlying.localeCompare(b.underlying));
}

/** Cotation exploitable : carnet des deux côtés et écart serré. */
export function isLiquid(p: LadderPoint): boolean {
  if (p.bid == null || p.ask == null) return false;
  if (!(p.ask > p.bid)) return false;
  return p.ask - p.bid <= MAX_SPREAD;
}

/** Prix retenu : milieu du carnet (plus fiable que le mid publié s'il diffère). */
export const quote = (p: LadderPoint): number => (p.bid != null && p.ask != null ? (p.bid + p.ask) / 2 : (p.mid ?? NaN));

/**
 * Régression isotone décroissante (pool-adjacent-violators) : la suite
 * non croissante la plus proche, au sens des moindres carrés, des valeurs
 * données. Laisse intacte une suite déjà décroissante.
 */
export function isotonicDecreasing(values: number[]): number[] {
  const blocks: { sum: number; n: number }[] = [];
  for (const v of values) {
    blocks.push({ sum: v, n: 1 });
    // Fusion tant que le bloc précédent est plus BAS que le courant (violation).
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1];
      const a = blocks[blocks.length - 2];
      if (a.sum / a.n >= b.sum / b.n) break;
      blocks.splice(blocks.length - 2, 2, { sum: a.sum + b.sum, n: a.n + b.n });
    }
  }
  return blocks.flatMap((b) => Array(b.n).fill(Math.min(1, Math.max(0, b.sum / b.n))));
}

export interface Bucket {
  /** Bornes de la tranche ; null = ouverte (−∞ ou +∞). */
  from: number | null;
  to: number | null;
  p: number;
}

export interface Distribution {
  thresholds: number[];
  /** S(K) corrigée : probabilité de finir au-dessus de chaque seuil. */
  survival: number[];
  buckets: Bucket[];
  /** Nombre de cotations retenues / disponibles. */
  used: number;
  total: number;
}

/** Distribution à partir des seules cotations liquides ; null s'il en reste moins de deux. */
export function distribution(ladder: Ladder): Distribution | null {
  const liquid = ladder.points.filter(isLiquid);
  if (liquid.length < 2) return null;
  const thresholds = liquid.map((p) => p.threshold);
  const survival = isotonicDecreasing(liquid.map(quote));
  const buckets: Bucket[] = [{ from: null, to: thresholds[0], p: 1 - survival[0] }];
  for (let i = 0; i < thresholds.length - 1; i++) {
    buckets.push({ from: thresholds[i], to: thresholds[i + 1], p: survival[i] - survival[i + 1] });
  }
  buckets.push({ from: thresholds[thresholds.length - 1], to: null, p: survival[survival.length - 1] });
  return { thresholds, survival, buckets, used: liquid.length, total: ladder.points.length };
}

/**
 * Probabilité de finir au-dessus d'un prix donné, par interpolation linéaire
 * de S entre deux seuils. null hors de la plage couverte : extrapoler serait
 * inventer.
 */
export function probAbove(d: Distribution, price: number): number | null {
  const { thresholds: k, survival: s } = d;
  if (price < k[0] || price > k[k.length - 1]) return null;
  for (let i = 0; i < k.length - 1; i++) {
    if (price >= k[i] && price <= k[i + 1]) {
      const w = k[i + 1] === k[i] ? 0 : (price - k[i]) / (k[i + 1] - k[i]);
      return s[i] + w * (s[i + 1] - s[i]);
    }
  }
  return s[s.length - 1];
}

/** Prix tel que S = 0,5 (médiane implicite) ; null si la plage ne l'encadre pas. */
export function impliedMedian(d: Distribution): number | null {
  const { thresholds: k, survival: s } = d;
  for (let i = 0; i < k.length - 1; i++) {
    if (s[i] >= 0.5 && s[i + 1] <= 0.5) {
      if (s[i] === s[i + 1]) return (k[i] + k[i + 1]) / 2;
      return k[i] + ((s[i] - 0.5) / (s[i] - s[i + 1])) * (k[i + 1] - k[i]);
    }
  }
  return null;
}
