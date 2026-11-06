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
  return (
    <nav className="flex items-center gap-0.5" aria-label="Sections">
      {items.map((it) => {
        const active = it.page === current;
        return (
          <a
            key={it.page}
            href={href(it.page)}
            aria-current={active ? "page" : undefined}
            className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
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
