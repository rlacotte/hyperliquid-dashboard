import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { wsManager, type Subscription, type WsStatus } from "./ws";

/**
 * Abonnement websocket lié au cycle de vie du composant.
 *
 * Le handler passe par une ref : le recréer à chaque rendu (cas normal d'une
 * fonction fléchée) ne doit pas provoquer désabonnement + réabonnement.
 * `sub = null` suspend l'abonnement (ex. panneau replié).
 */
export function useHlSubscription(sub: Subscription | null, handler: (data: any) => void) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const key = sub ? JSON.stringify(sub) : null;

  useEffect(() => {
    if (!sub) return;
    return wsManager.subscribe(sub, (d) => handlerRef.current(d));
    // `key` capture l'identité de l'abonnement ; `sub` est recréé à chaque rendu.
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
}

export function useWsStatus(): WsStatus {
  return useSyncExternalStore(
    (cb) => wsManager.onStatus(cb),
    () => wsManager.getStatus()
  );
}

/**
 * Mids en direct d'un DEX. Hyperliquid pousse le dictionnaire complet à chaque
 * message : on le fusionne plutôt que de le remplacer, pour qu'un message
 * partiel éventuel n'efface pas les prix déjà connus.
 */
export function useLiveMids(dex = ""): Record<string, number> {
  const [mids, setMids] = useState<Record<string, number>>({});
  useHlSubscription(dex ? { type: "allMids", dex } : { type: "allMids" }, (data) => {
    const incoming = data?.mids as Record<string, string> | undefined;
    if (!incoming) return;
    setMids((prev) => {
      const next = { ...prev };
      for (const k in incoming) {
        const v = parseFloat(incoming[k]);
        if (Number.isFinite(v)) next[k] = v;
      }
      return next;
    });
  });
  return mids;
}

/**
 * Mids en direct de plusieurs DEX, fusionnés dans un seul dictionnaire.
 *
 * Les ids HIP-3 sont déjà préfixés ("xyz:TSLA"), les ids du DEX principal ne
 * le sont pas : aucune collision possible à la fusion. Les mises à jour sont
 * regroupées par frame d'animation — avec une dizaine de DEX qui poussent
 * chacun leur dictionnaire, re-rendre le tableau à chaque message serait du
 * travail jeté.
 */
export function useLiveMidsAll(dexs: string[]): Record<string, number> {
  const [mids, setMids] = useState<Record<string, number>>({});
  const key = [...dexs].sort().join(",");

  useEffect(() => {
    const pending: Record<string, number> = {};
    let frame: number | null = null;
    const flush = () => {
      frame = null;
      const batch = { ...pending };
      for (const k in pending) delete pending[k];
      setMids((prev) => ({ ...prev, ...batch }));
    };
    const onData = (data: { mids?: Record<string, string> }) => {
      if (!data?.mids) return;
      for (const k in data.mids) {
        // Les marchés d'issue ("#123") partagent le flux du DEX principal :
        // inutiles au tableau, on ne les stocke pas.
        if (k.charCodeAt(0) === 35) continue;
        const v = parseFloat(data.mids[k]);
        if (Number.isFinite(v)) pending[k] = v;
      }
      if (frame === null) frame = requestAnimationFrame(flush);
    };
    const unsubs = key.split(",").map((dex) =>
      wsManager.subscribe(dex ? { type: "allMids", dex } : { type: "allMids" }, onData)
    );
    return () => {
      unsubs.forEach((u) => u());
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [key]);

  return mids;
}

interface PollState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  /** Horodatage local du dernier succès. */
  updatedAt: number | null;
  refresh: () => void;
}

/**
 * Polling d'une requête REST Hyperliquid. Se met en pause quand l'onglet est
 * masqué : inutile de consommer le quota de débit (par IP) pour un écran que
 * personne ne regarde, et la requête repart immédiatement au retour.
 */
export function useHlPoll<T>(fetcher: (signal: AbortSignal) => Promise<T>, intervalMs: number, deps: unknown[] = []): PollState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;

    const run = async () => {
      if (document.hidden) {
        timer = setTimeout(run, 1000);
        return;
      }
      controller = new AbortController();
      try {
        const result = await fetcherRef.current(controller.signal);
        if (cancelled) return;
        setData(result);
        setError(null);
        setUpdatedAt(Date.now());
      } catch (e) {
        if (cancelled || (e instanceof DOMException && e.name === "AbortError")) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) {
          setLoading(false);
          timer = setTimeout(run, intervalMs);
        }
      }
    };
    run();

    return () => {
      cancelled = true;
      controller?.abort();
      if (timer) clearTimeout(timer);
    };
  }, [intervalMs, tick, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps

  return { data, error, loading, updatedAt, refresh: () => setTick((t) => t + 1) };
}
