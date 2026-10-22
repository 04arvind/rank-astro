import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import HideOnRoot from "./_components/HideOnRoot";
import { getRole, type Role } from "./_lib/role";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: { default: "Astrologer Ranking", template: "%s · Astrologer Ranking" },
  description: "Personalised astrologer ranking",
};

const NAV_LINKS = {
  home: <Link key="home" href="/user" className="text-zinc-600 hover:text-zinc-900">Home</Link>,
  astrologers: <Link key="astrologers" href="/user/astrologers" className="font-semibold text-zinc-900">Astrologers</Link>,
  user: <Link key="user" href="/user/consult" className="text-zinc-600 hover:text-zinc-900">User</Link>,
  dashboard: <Link key="dashboard" href="/admin" className="text-zinc-600 hover:text-zinc-900">Dashboard</Link>,
};

/** Navbar per role picked at "/"; astrologers have the dashboard's own header instead. */
const NAV_BY_ROLE: Record<Role | "none", (keyof typeof NAV_LINKS)[]> = {
  user: ["home", "astrologers", "user"],
  admin: ["dashboard"],
  astrologer: [],
  // No role yet: every role's pages redirect to "/", so there is nothing to link to.
  none: [],
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const nav = NAV_BY_ROLE[(await getRole()) ?? "none"];
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-zinc-50">
        {nav.length > 0 && (
          <HideOnRoot>
            <nav className="relative z-10 border-b border-celestial-900/10 bg-transparent">
              <div className="mx-auto flex max-w-7xl items-center gap-6 px-4 py-3 text-sm">
                {nav.map((k) => NAV_LINKS[k])}
              </div>
            </nav>
          </HideOnRoot>
        )}
        {children}
      </body>
    </html>
  );
}
