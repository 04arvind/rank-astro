import { Cormorant_Garamond } from "next/font/google";

/** Serif display face for headings; exposed as --font-display-serif (see globals.css → font-display). */
export const display = Cormorant_Garamond({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  style: ["normal", "italic"],
  variable: "--font-display-serif",
});
