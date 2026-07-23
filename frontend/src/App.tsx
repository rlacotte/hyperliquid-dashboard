import { useCallback, useState } from "react";
import { api } from "./api";
import { usePolling } from "./hooks/usePolling";
import { MarketsTable } from "./components/MarketsTable";
import { AlertsPanel } from "./components/AlertsPanel";
import { AssetDetail } from "./components/AssetDetail";
import { GlobalMetricsBar } from "./components/GlobalMetricsBar";

export default function App() {
  const [selectedCoin, setSelectedCoin] = useState<string | null>(null);

  const markets = usePolling(() => api.markets(), 5000);
  const alerts = usePolling(() => api.alerts(100, true), 5000);
  const confluence = usePolling(() => api.confluence(0), 5000);

  const handleAck = useCallback(async (id: number) => {
    try {
      await api.ackAlert(id);
      alerts.refresh();
    } catch (e) {
      console.error(e);
    }
  }, [alerts]);

  const handleAckAll = useCallback(async () => {
    try {
      await api.ackAll();
      alerts.refresh();
    } catch (e) {
      console.error(e);
    }
  }, [alerts]);

  const selectedAsset = selectedCoin
    ? markets.data?.assets.find((a) => a.coin === selectedCoin)
    : undefined;

  const selectedConfluence = selectedCoin
    ? confluence.data?.scores.find((s) => s.coin === selectedCoin)
    : undefined;

  return (
    <div className="flex h-screen flex-col">
      {/* Header */}
      <header className="flex items-center gap-3 border-b border-bg-border bg-bg-panel px-6 py-3">
        <h1 className="text-lg font-bold text-white">
          <span className="text-blue-500">⚡</span> Hyperliquid Dashboard
        </h1>
        <div className="ml-auto flex items-center gap-4 text-xs text-gray-500">
          {markets.data && (
            <span>
              {markets.data.assets.length} actifs · Maj{" "}
              {new Date(markets.data.ts).toLocaleTimeString("fr-FR")}
            </span>
          )}
          <span className="flex items-center gap-1">
            <span className={`h-2 w-2 rounded-full ${markets.error ? "bg-red-500" : "bg-green-500 animate-pulse"}`} />
            {markets.error ? "Erreur" : "Live"}
          </span>
        </div>
      </header>

      {/* Bandeau métriques globales */}
      <GlobalMetricsBar />

      {/* Contenu principal */}
      <main className="flex flex-1 gap-4 overflow-hidden p-4">
        {/* Table des marchés */}
        <div className="flex-1 overflow-hidden">
          {markets.error && !markets.data ? (
            <div className="flex h-full items-center justify-center text-red-400">
              Erreur: {markets.error}
            </div>
          ) : markets.loading && !markets.data ? (
            <div className="flex h-full items-center justify-center text-gray-500">
              Chargement des marchés...
            </div>
          ) : markets.data ? (
            <MarketsTable
              assets={markets.data.assets}
              confluenceScores={confluence.data?.scores ?? []}
              onSelectCoin={setSelectedCoin}
              selectedCoin={selectedCoin}
            />
          ) : null}
        </div>

        {/* Panneau d'alertes */}
        <aside className="w-80 shrink-0 overflow-hidden">
          <AlertsPanel
            alerts={alerts.data ?? []}
            onAck={handleAck}
            onAckAll={handleAckAll}
            onSelectCoin={setSelectedCoin}
          />
        </aside>
      </main>

      {/* Modal détail actif */}
      {selectedCoin && (
        <AssetDetail
          coin={selectedCoin}
          asset={selectedAsset}
          confluence={selectedConfluence}
          onClose={() => setSelectedCoin(null)}
        />
      )}
    </div>
  );
}
