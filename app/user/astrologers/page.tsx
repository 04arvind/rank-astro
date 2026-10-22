import { config } from "@/config";
import AstrologerBrowser from "../../_components/AstrologerBrowser";
import CelestialPage from "../../_components/CelestialPage";

export const metadata = { title: "Astrologers" };

export default function AstrologersPage() {
  return (
    <CelestialPage eyebrow="Guidance from the stars" title="Talk to an astrologer">
      <AstrologerBrowser
        categories={config.catalog.categories}
        languages={config.catalog.languages}
        layout={{
          premiumSlots: config.ranking.premiumSlots.enabled ? config.ranking.premiumSlots.count : 0,
          firstBanditSlot: config.ranking.bandit.firstSlot,
          lastBanditSlot: config.ranking.bandit.slots,
          limit: config.ranking.pagination.maxLimit,
        }}
      />
    </CelestialPage>
  );
}
