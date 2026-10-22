"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { isRole, ROLE_COOKIE, ROLE_HOME } from "./role";

/** Remembers the picked role and sends the visitor to that role's landing page. */
export async function selectRole(formData: FormData): Promise<void> {
  const role = formData.get("role");
  if (!isRole(role)) redirect("/");
  (await cookies()).set(ROLE_COOKIE, role, { path: "/", sameSite: "lax", maxAge: 60 * 60 * 24 * 30 });
  redirect(ROLE_HOME[role]);
}
