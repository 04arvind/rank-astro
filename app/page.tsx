import CelestialPage from "./_components/CelestialPage";
import type { Role } from "./_lib/role";
import { selectRole } from "./_lib/roleActions";

export const metadata = { title: "Choose your role" };

const CARDS: { role: Role; title: string; text: string; glyph: string }[] = [
  { role: "user", title: "User Login", text: "Find an astrologer and book a consultation.", glyph: "☉" },
  { role: "astrologer", title: "Astrologer Login", text: "Take consultations and manage your calls.", glyph: "✴" },
  { role: "admin", title: "Admin Login", text: "Monitor ranking, providers and bookings.", glyph: "♄" },
];

/** Role picker: no authentication yet, the choice only sets where each role lands and its navbar. */
export default function RoleSelectPage() {
  return (
    <CelestialPage eyebrow="Welcome" title="Continue as">
      <form action={selectRole} className="grid gap-5 sm:grid-cols-3">
        {CARDS.map((c) => (
          <button
            key={c.role}
            type="submit"
            name="role"
            value={c.role}
            className="group flex flex-col items-start gap-3 rounded-2xl border border-celestial-900/10 bg-white/70 p-6 text-left shadow-sm backdrop-blur-sm transition duration-300 hover:-translate-y-0.5 hover:border-gold-400/70 hover:bg-white/90 hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-celestial-600 active:scale-[0.98]"
          >
            <span aria-hidden="true" className="flex h-12 w-12 items-center justify-center rounded-full bg-celestial-50 text-2xl text-celestial-700 ring-1 ring-gold-300/60">
              {c.glyph}
            </span>
            <span className="font-display text-2xl font-semibold text-celestial-900">{c.title}</span>
            <span className="text-sm leading-relaxed text-celestial-800/70">{c.text}</span>
            <span className="mt-auto pt-2 text-sm font-medium text-celestial-700 transition-transform duration-300 group-hover:translate-x-1">
              Continue <span aria-hidden="true">→</span>
            </span>
          </button>
        ))}
      </form>
    </CelestialPage>
  );
}
