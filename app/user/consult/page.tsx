import { connection } from "next/server";
import DurationPicker from "@/components/user/DurationPicker";
import { getDurationOffers } from "@/lib/consultation/offers";
import CelestialPage from "../../_components/CelestialPage";

export const metadata = { title: "User" };

export default async function UserPage() {
  // Prices, counts and who's online come from the live astrologer pool.
  await connection();
  const offers = await getDurationOffers();

  return (
    <CelestialPage eyebrow="Your consultation" title="Choose a duration">
      <p className="-mt-5 mb-10 max-w-xl text-base leading-relaxed text-celestial-800/70">
        Pick how long you&apos;d like to talk. Every consultation is with a verified astrologer.
      </p>
      <DurationPicker offers={offers} />
    </CelestialPage>
  );
}
