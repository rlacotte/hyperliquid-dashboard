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
import { WalletPage } from "./pages/WalletPage";
import { TapePage } from "./pages/TapePage";
import { SmartMoneyPage } from "./pages/SmartMoneyPage";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { SignalsPage } from "./pages/SignalsPage";
import { PredictionsPage } from "./pages/PredictionsPage";
import { WalletWatcher } from "./components/WalletWatcher";

const NAV: NavItem[] = [
  { page: "markets", label: "Marchés" },
  { page: "tape", label: "Flux live" },
  { page: "smart-money", label: "Smart money" },
  { page: "signals", label: "Signaux" },
  { page: "funding", label: "Funding" },
  { page: "predictions", label: "Prédictions" },
  { page: "wallet", label: "Wallet" },
];

export default function App() {
  const route = useRoute();
  const ws = useWsStatus();
  // Fraîcheur des SIGNAUX (cycle de collecte serveur), distincte de celle des
  // prix qui arrivent en direct par websocket.
  const health = usePolling(() => api.health(), 30_000);
  const signalsTs = health.data?.last_fetch_ms || undefined;

  // h-dvh et non h-screen : sur mobile, 100vh inclut la barre d'adresse du
  // navigateur et masque le bas de l'écran.
  return (
    <div className="flex h-dvh flex-col">
      <header className="border-b border-bg-border bg-bg-panel">
        <div className="flex items-center gap-3 px-3 py-2 md:gap-4 md:px-6 md:py-2.5">
          <a href="#/markets" className="shrink-0 text-base font-bold text-white md:text-lg">
            {/* Nom complet seulement quand la navigation tient à côté (≥ 1280 px). */}
            <span className="text-blue-500">⚡</span> <span className="hidden xl:inline">Hyperliquid Dashboard</span>
            <span className="xl:hidden">Hyperliquid</span>
          </a>
          <div className="hidden min-w-0 lg:block">
            <Nav items={NAV} current={route.page} />
          </div>
          <div className="ml-auto shrink-0">
            <StatusBadge ws={ws} signalsTs={signalsTs} signalsError={health.error} />
          </div>
        </div>
        {/* Sous 1024 px, navigation sur sa propre ligne, défilable : sept
            sections + logo + état (~1000 px) ne tiennent pas sur une ligne. */}
        <div className="no-scrollbar overflow-x-auto px-2 pb-1.5 lg:hidden">
          <Nav items={NAV} current={route.page} />
        </div>
      </header>

      <StaleBanner ws={ws} signalsTs={signalsTs} signalsError={health.error} />
      <ErrorBoundary resetKey="metrics">
        <GlobalMetricsBar />
      </ErrorBoundary>

      {/* Une barrière par page : une erreur dans une section laisse l'en-tête
          et la navigation utilisables. Elle est réinitialisée au changement de page. */}
      <ErrorBoundary resetKey={`${route.page}/${route.params.join("/")}`}>
        {route.page === "funding" ? (
          <FundingPage />
        ) : route.page === "wallet" ? (
          <WalletPage address={route.params[0]} />
        ) : route.page === "tape" ? (
          <TapePage />
        ) : route.page === "smart-money" ? (
          <SmartMoneyPage />
        ) : route.page === "signals" ? (
          <SignalsPage />
        ) : route.page === "predictions" ? (
          <PredictionsPage />
        ) : (
          // Les sections inconnues retombent sur les marchés : un lien partagé
          // ne doit jamais afficher une page vide.
          <MarketsPage />
        )}
      </ErrorBoundary>

      {/* Surveillance des wallets suivis : active sur toutes les pages. */}
      <ErrorBoundary resetKey="watcher">
        <WalletWatcher />
      </ErrorBoundary>
    </div>
  );
}
