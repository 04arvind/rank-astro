import { connection } from "next/server";
import LoginPicker, { type LoginOption } from "@/components/astrologer-portal/LoginPicker";
import { config } from "@/config";
import { getAstrologerRepository } from "@/lib/astrologer";
import { pendingRequestCounts } from "@/lib/astrologer-portal";
import { logError } from "@/lib/errors";
import type { AstrologerProfile } from "@/types/astrologer";
import CelestialPage from "../../_components/CelestialPage";
import { getSignedInAstrologer } from "../../_lib/astrologerSession";

export const metadata = { title: "Astrologer login" };

const providerName = new Map(config.providers.providers.map((p) => [p.id, p.name]));
const catalogLabel = new Map([...config.catalog.categories, ...config.catalog.specializations].map((c) => [c.id, c.label]));

const toOption = (a: AstrologerProfile, pending: ReadonlyMap<string, number>): LoginOption => ({
  id: a.id,
  newRequests: pending.get(a.id) ?? 0,
  name: a.name,
  provider: providerName.get(a.providerId) ?? a.providerId,
  avatarUrl: a.avatarUrl,
  expertise: [...a.categories, ...a.specializations]
    .slice(0, 3)
    .map((id) => catalogLabel.get(id) ?? id)
    .join(", "),
});

export default async function AstrologerLoginPage() {
  await connection();
  const [all, current, pending] = await Promise.all([
    getAstrologerRepository().list(),
    getSignedInAstrologer(),
    // The dots are a nicety: without them the login still works.
    pendingRequestCounts().catch((err) => {
      logError(err, { scope: "astrologer-login", operation: "pendingCounts" });
      return new Map<string, number>();
    }),
  ]);
  const options = all.map((a) => toOption(a, pending)).sort((x, y) => x.name.localeCompare(y.name));

  return (
    <CelestialPage eyebrow="Astrologer login" title="Welcome back">
      <p className="-mt-5 mb-8 max-w-xl text-base leading-relaxed text-celestial-800/70">
        Choose your profile to manage your consultations, calendar and earnings.
      </p>
      <LoginPicker options={options} current={current ? toOption(current, pending) : null} />
    </CelestialPage>
  );
}
