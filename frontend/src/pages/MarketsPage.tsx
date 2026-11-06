import { useCallback, useMemo, useState } from "react";
import { api } from "../api";
import { hl, type Market } from "../hl/client";
import { useHlPoll, useLiveMidsAll } from "../hl/hooks";
import { usePolling } from "../hooks/usePolling";
import { MarketsTable } from "../components/MarketsTable";
import { AlertsPanel } from "../components/AlertsPanel";
import { AssetDetail } from "../components/AssetDetail";
import type { ConfluenceScore } from "../types";

export function MarketsPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Contexte lent (funding, OI, volume) en REST direct ; les prix arrivent en
  // continu par websocket. Cf. hl.allMarkets pour le budget de débit.
  const markets = useHlPoll(() => hl.allMarkets(), 30_000);
  const oiCaps = useHlPoll(() => hl.oiCaps(), 60_000);

  const dexs = useMemo(() => {
    const s = new Set<string>([""]);
    for (const m of markets.data ?? []) if (m.kind === "hip3") s.add(m.dex);
    return [...s];
  }, [markets.data]);
  const mids = useLiveMidsAll(dexs);

  // Signaux calculés côté serveur (historique nécessaire)
  const confluence = usePolling(() => api.confluence(0), 15_000);
  const alerts = usePolling(() => api.alerts(100, true), 15_000);
  // Bilan historique par type d'alerte, affiché sous chaque alerte.
  const track = usePolling(() => api.trackRecord(), 300_000);

  const confluenceById = useMemo(() => {
    const m = new Map<string, ConfluenceScore>();
    for (const s of confluence.data?.scores ?? []) m.set(s.coin, s);
    return m;
  }, [confluence.data]);
  const capSet = useMemo(() => new Set(oiCaps.data ?? []), [oiCaps.data]);

  const byId = useMemo(() => new Map((markets.data ?? []).map((m) => [m.id, m])), [markets.data]);
  const selected: Market | undefined = selectedId ? byId.get(selectedId) : undefined;

  const handleAck = useCallback(
    async (id: number) => {
      try {
        await api.ackAlert(id);
        alerts.refresh();
      } catch (e) {
        console.error(e);
      }
    },
    [alerts]
  );
  const handleAckAll = useCallback(async () => {
    try {
      await api.ackAll();
      alerts.refresh();
    } catch (e) {
      console.error(e);
    }
  }, [alerts]);

  return (
    <main className="flex flex-1 gap-4 overflow-hidden p-4">
      <div className="min-w-0 flex-1 overflow-hidden">
        {markets.error && !markets.data ? (
          <div className="flex h-full items-center justify-center text-red-400">Erreur : {markets.error}</div>
        ) : !markets.data ? (
          <div className="flex h-full items-center justify-center text-gray-500">Chargement des marchés…</div>
        ) : (
          <MarketsTable
            markets={markets.data}
            mids={mids}
            confluence={confluenceById}
            oiCaps={capSet}
            selectedId={selectedId}
            onSelect={(m) => setSelectedId(m.id)}
          />
        )}
      </div>

      <aside className="hidden w-80 shrink-0 overflow-hidden lg:block">
        <AlertsPanel
          alerts={alerts.data ?? []}
          onAck={handleAck}
          onAckAll={handleAckAll}
          onSelectCoin={(coin) => setSelectedId(coin)}
          track={track.data}
        />
      </aside>

      {selected && (
        <AssetDetail
          market={selected}
          livePx={mids[selected.id]}
          confluence={confluenceById.get(selected.id)}
          onClose={() => setSelectedId(null)}
        />
      )}
    </main>
  );
}
