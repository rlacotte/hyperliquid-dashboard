import { useEffect, useRef } from "react";
import { href, type Page } from "../router";

export interface NavItem {
  page: Page;
  label: string;
}

interface Props {
  items: NavItem[];
  current: Page;
}

export function Nav({ items, current }: Props) {
  const ref = useRef<HTMLElement>(null);
  // Sur téléphone la barre défile : l'onglet actif (Prédictions, Wallet…) peut
  // être hors champ après une navigation par lien — on le ramène en vue.
  useEffect(() => {
    ref.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [current]);
  return (
    <nav ref={ref} className="flex w-max items-center gap-0.5" aria-label="Sections">
      {items.map((it) => {
        const active = it.page === current;
        return (
          <a
            key={it.page}
            href={href(it.page)}
            aria-current={active ? "page" : undefined}
            className={`shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 text-sm transition-colors ${
              active ? "bg-bg-hover text-white" : "text-gray-400 hover:bg-bg-hover/60 hover:text-gray-200"
            }`}
          >
            {it.label}
          </a>
        );
      })}
    </nav>
  );
}
