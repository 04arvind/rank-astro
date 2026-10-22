/**
 * Exports learned-ranker training data from MongoDB.
 *
 *   npm run ml:export -- [--days 30] [--out data/ml]
 *
 * Writes <out>/training.jsonl (one row per served item: qid, at, label,
 * position, features) and <out>/training.meta.json (feature names, counts).
 * Labels: 3 completed consultation, 2 booked, 1 clicked, 0 shown.
 * Then: npm run ml:train. Reads MONGO_URI from .env like `next dev` does.
 */
import { loadEnvConfig } from "@next/env";
import { args, heading, intArg, main, ROOT, writeJson, writeProjectFile } from "./_lib/cli";

loadEnvConfig(ROOT);

main("ml:export", async () => {
  const opts = args(`\nUsage: npm run ml:export -- [--days 30] [--out data/ml]\n`, { days: { type: "string" }, out: { type: "string" } });
  const days = intArg(opts.days, 30, "days");
  const out = opts.out ?? "data/ml";
  const { closeDb, installDatabase } = await import("@/db");
  const { buildTrainingSet } = await import("@/lib/ranking/ml");
  if (!(await installDatabase())) {
    console.error("MongoDB is not configured or unreachable; the training log lives in MongoDB.");
    return 1;
  }

  try {
    const now = Date.now();
    const set = await buildTrainingSet({ from: now - days * 86_400_000, to: now, now });
    heading(`Training set — last ${days} days`);
    console.log(`${set.queries} lists · ${set.positiveQueries} with an outcome · ${set.rows.length} rows`);
    console.log(`labels: ${[0, 1, 2, 3].map((l) => `${l}=${set.rows.filter((r) => r.label === l).length}`).join(" ")}`);
    if (set.skipped.otherFeatureVersion) console.log(`skipped ${set.skipped.otherFeatureVersion} lists logged with an older feature layout`);

    const jsonl = set.rows.map((r) => JSON.stringify(r)).join("\n");
    const data = await writeProjectFile(`${out}/training.jsonl`, jsonl ? `${jsonl}\n` : "");
    const meta = await writeJson(`${out}/training.meta.json`, {
      featureNames: set.featureNames,
      featureVersion: set.featureVersion,
      exportedAt: new Date(now).toISOString(),
      from: new Date(set.from).toISOString(),
      to: new Date(set.to).toISOString(),
      queries: set.queries,
      positiveQueries: set.positiveQueries,
      rows: set.rows.length,
    });
    console.log(`wrote ${data} and ${meta}`);
    return 0;
  } finally {
    await closeDb();
  }
});
