import { api } from "./api";
import { usePolling } from "./hooks/usePolling";
import { useWsStatus } from "./hl/hooks";
import { useRoute } from "./router";
import { Nav, type NavItem } from "./components/Nav";
import { GlobalMetricsBar } from "./components/GlobalMetricsBar";
import { StatusBadge } from "./components/StatusBadge";
import { StaleBanner } from "./components/StaleBanner";
import { MarketsPage } from "./pages/MarketsPage";
import { FundingPage } from "./pages/FundingPage";

const NAV: NavItem[] = [
  { page: "markets", label: "Marchés" },
  { page: "funding", label: "Funding" },
];

export default function App() {
  const route = useRoute();
  const ws = useWsStatus();
  // Fraîcheur des SIGNAUX (cycle de collecte serveur), distincte de celle des
  // prix qui arrivent en direct par websocket.
  const health = usePolling(() => api.health(), 15_000);
  const signalsTs = health.data?.last_fetch_ms || undefined;

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-4 border-b border-bg-border bg-bg-panel px-6 py-2.5">
        <a href="#/markets" className="shrink-0 text-lg font-bold text-white">
          <span className="text-blue-500">⚡</span> Hyperliquid Dashboard
        </a>
        <Nav items={NAV} current={route.page} />
        <div className="ml-auto">
          <StatusBadge ws={ws} signalsTs={signalsTs} signalsError={health.error} />
        </div>
      </header>

      <StaleBanner ws={ws} signalsTs={signalsTs} signalsError={health.error} />
      <GlobalMetricsBar />

      {/* Les sections non encore construites retombent sur les marchés : un
          lien partagé vers une section future ne doit jamais afficher une page vide. */}
      {route.page === "funding" ? <FundingPage /> : <MarketsPage />}
    </div>
  );
}
