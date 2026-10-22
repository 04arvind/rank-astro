/**
 * Sync provider feeds into MongoDB.
 *
 *   npm run db:sync
 *
 * Reads every enabled provider feed (data/csv/*), normalizes it and upserts
 * the astrologers into the `astrologers` collection, removing ones that
 * disappeared from a feed. A feed that fails to load leaves that provider's
 * astrologers untouched. Reads MONGO_URI from .env like `next dev` does.
 */
import { loadEnvConfig } from "@next/env";
import { args, heading, main, ROOT } from "./_lib/cli";

loadEnvConfig(ROOT);

main("db-sync", async () => {
  args(`\nUsage: npm run db:sync\n`, {});
  const { closeDb, ensureIndexes, isDatabaseConfigured, syncAstrologersFromFeeds } = await import("@/db");
  if (!isDatabaseConfigured()) {
    console.error("MONGO_URI is not set (add it to .env).");
    return 1;
  }

  try {
    await ensureIndexes();
    const r = await syncAstrologersFromFeeds();

    heading("Astrologers synced to MongoDB");
    console.table(Object.entries(r.byProvider).map(([providerId, astrologers]) => ({ providerId, astrologers })));
    console.log(`inserted ${r.upserted} · updated ${r.modified} · removed ${r.removed} · rejected rows ${r.rejected.length}`);
    for (const x of r.rejected) console.log(`  rejected ${x.providerId} ${x.ref}: ${x.issues.map((i) => `${i.path} ${i.message}`).join("; ")}`);
    for (const f of r.failed) console.warn(`  ⚠ ${f.providerId} feed not loaded (left unchanged): ${f.message}`);
    return r.failed.length ? 1 : 0;
  } finally {
    await closeDb();
  }
});
