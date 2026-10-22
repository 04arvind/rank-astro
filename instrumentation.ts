/** Runs once per server start: connects MongoDB and installs the DB-backed stores (see db/). */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { installDatabase } = await import("./db");
    await installDatabase();
  }
}
