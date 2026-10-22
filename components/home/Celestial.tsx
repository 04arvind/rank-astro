import type { CSSProperties } from "react";

/*
 * Minimal line-art ornaments for the landing page. All are decorative
 * (aria-hidden) and draw in currentColor so the parent sets the tone.
 */

/** Four-point sparkle. */
export function Sparkle({ className = "", style }: { className?: string; style?: CSSProperties }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className} style={style}>
      <path d="M12 0c.6 5.6 2.4 7.8 12 12-9.6 4.2-11.4 6.4-12 12-.6-5.6-2.4-7.8-12-12C9.6 7.8 11.4 5.6 12 0Z" fill="currentColor" />
    </svg>
  );
}

/** A small constellation: thin lines between a handful of stars. */
export function Constellation({ className = "" }: { className?: string }) {
  const stars: [number, number, number][] = [
    [8, 58, 1.6],
    [46, 40, 2.2],
    [92, 48, 1.4],
    [128, 22, 2.4],
    [170, 30, 1.5],
    [196, 64, 1.9],
    [150, 78, 1.3],
  ];
  const path = "M8 58 L46 40 L92 48 L128 22 L170 30 L196 64 L150 78 L92 48";
  return (
    <svg viewBox="0 0 204 90" fill="none" aria-hidden="true" className={className}>
      <path d={path} stroke="currentColor" strokeOpacity={0.45} strokeWidth={0.7} />
      {stars.map(([x, y, r]) => (
        <circle key={`${x}-${y}`} cx={x} cy={y} r={r} fill="currentColor" />
      ))}
    </svg>
  );
}

/** Hairline divider with a centred star, for card bodies and section headings. */
export function StarRule({ className = "" }: { className?: string }) {
  return (
    <span aria-hidden="true" className={`flex items-center gap-3 ${className}`}>
      <span className="h-px flex-1 bg-gradient-to-r from-transparent to-current opacity-40" />
      <Sparkle className="h-2.5 w-2.5" />
      <span className="h-px flex-1 bg-gradient-to-l from-transparent to-current opacity-40" />
    </span>
  );
}

// Text-presentation selector keeps these glyphs from rendering as emoji.
const TEXT = "\uFE0E";
export const ZODIAC = ["♈", "♉", "♊", "♋", "♌", "♍", "♎", "♏", "♐", "♑", "♒", "♓"].map((g) => g + TEXT);
export const glyph = (g: string) => g + TEXT;
