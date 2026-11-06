import { useSyncExternalStore } from "react";

/**
 * Routage par hash (#/funding, #/wallet/0xabc...).
 *
 * Par hash plutôt que par chemin : un chemin profond (/wallet/0x...) rechargé
 * directement tomberait sur la réécriture /api de vercel.json ou sur un 404
 * statique, sauf à ajouter une règle SPA. Le hash ne quitte jamais le
 * navigateur : aucune configuration serveur, et les URLs restent partageables.
 */

export type Page = "markets" | "funding" | "smart-money" | "wallet" | "tape" | "signals";

export interface Route {
  page: Page;
  params: string[];
}

const PAGES: Page[] = ["markets", "funding", "smart-money", "wallet", "tape", "signals"];

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const page = (parts[0] ?? "markets") as Page;
  if (!PAGES.includes(page)) return { page: "markets", params: [] };
  return { page, params: parts.slice(1) };
}

function subscribe(cb: () => void) {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  return parseRoute(hash);
}

export function href(page: Page, ...params: string[]): string {
  const tail = params.map(encodeURIComponent).join("/");
  return `#/${page}${tail ? `/${tail}` : ""}`;
}

export function navigate(page: Page, ...params: string[]) {
  window.location.hash = href(page, ...params);
}
