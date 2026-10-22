import Image from "next/image";
import type { ReactNode } from "react";
import bgImg from "@/assets/bg_img.png";
import { display } from "./fonts";

interface CelestialPageProps {
  /** Small gold line above the title. */
  eyebrow: string;
  title: string;
  children: ReactNode;
}

/** Shared shell for the user-facing pages: celestial background, display font, heading and page width. */
export default function CelestialPage({ eyebrow, title, children }: CelestialPageProps) {
  return (
    <div className={`${display.variable} flex-1`}>
      {/*
        Celestial sky, softened toward ivory/lavender so cards stay legible.
        -z-10 in the root stacking context keeps it behind the layout's nav;
        don't add isolate/z-index to an ancestor or it will paint over the nav.
      */}
      <div aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10">
        <Image src={bgImg} alt="" fill preload placeholder="blur" sizes="100vw" className="object-cover object-top" />
        <div className="absolute inset-0 bg-gradient-to-b from-ivory-50/30 via-lavender-50/55 to-ivory-100/85" />
      </div>

      <main className="mx-auto w-full max-w-7xl px-4 py-10">
        <p className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.25em] text-gold-600">
          <span aria-hidden="true">✦</span> {eyebrow}
        </p>
        <h1 className="mb-8 font-display text-4xl font-semibold tracking-tight text-celestial-900 sm:text-5xl">{title}</h1>
        {children}
      </main>
    </div>
  );
}
