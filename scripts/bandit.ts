/**
 * Thompson-sampling maintenance against MongoDB.
 *
 *   npm run bandit -- --action report      treatment vs holdout, providers, lag
 *   npm run bandit -- --action reconcile   credit completed consultations now
 *   npm run bandit -- --action rebuild     recompute arm counters from the ledgers
 *
 * Reconciliation already runs on demand from the ranking routes; schedule
 * `reconcile` (e.g. every 5–15 min) only if User-Choice traffic is too
 * sparse to trigger it. Reads MONGO_URI from .env like `next dev` does.
 */
import { loadEnvConfig } from "@next/env";
import { args, heading, main, ROOT } from "./_lib/cli";

loadEnvConfig(ROOT);

main("bandit", async () => {
  const { action = "report" } = args(`\nUsage: npm run bandit -- --action report|reconcile|rebuild\n`, { action: { type: "string" } });
  const { closeDb, installDatabase } = await import("@/db");
  const bandit = await import("@/lib/ranking/bandit");
  if (!(await installDatabase())) {
    console.error("MongoDB is not configured or unreachable; bandit state lives in MongoDB.");
    return 1;
  }

  try {
    if (action === "reconcile") {
      heading("Reconcile outcomes");
      console.log(await bandit.reconcileOutcomes());
    } else if (action === "rebuild") {
      heading("Rebuild arms");
      console.log(`${await bandit.rebuildArms()} arms rebuilt`);
    } else if (action === "report") {
      const r = await bandit.getBanditReport();
      heading(`Bandit ${r.policy} — mode ${r.mode.mode} (${r.mode.source})`);
      console.table(r.variants.map(({ interval, ...v }) => ({ ...v, ci: interval?.map((x) => x.toFixed(4)).join("…") })));
      console.log(r.lift ? `lift ${r.lift.rateDiff.toFixed(4)} [${r.lift.interval.map((x) => x.toFixed(4)).join(", ")}] significant=${r.lift.significant}` : "lift: not enough data");
      console.table(r.providers);
      console.log("outcomes", r.outcomes, "reconcile", r.reconcile);
    } else {
      console.error(`Unknown action "${action}"`);
      return 2;
    }
    return 0;
  } finally {
    await closeDb();
  }
});
