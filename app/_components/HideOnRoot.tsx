"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/** Renders its children everywhere except the role picker at "/". */
export default function HideOnRoot({ children }: { children: ReactNode }) {
  return usePathname() === "/" ? null : children;
}
