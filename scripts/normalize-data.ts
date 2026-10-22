/**
 * Normalize provider feeds into the snapshot the app loads.
 *
 *   npm run data:normalize -- [--dry-run] [--out data/normalized/astrologers.json] [--strict]
 *
 * Runs every provider feed through lib/astrologer's normalization and writes
 *   - data/normalized/astrologers.json  (read by SnapshotAstrologerRepository)
 *   - data/normalized/rejected.json     (rows that failed, with reasons)
 * Existing files are only replaced after the whole run succeeds.
 */
import path from "node:path";
import { normalizeFeeds, NORMALIZED_SNAPSHOT } from "@/lib/astrologer";
import { countBy } from "@/lib/utils/collections";
import { args, heading, main, ROOT, writeJson } from "./_lib/cli";
import { loadFeeds, parseFileOverrides } from "./_lib/data";

const USAGE = `
Usage: npm run data:normalize -- [options]

  --provider <id>   Only these providers (repeatable). Default: all configured.
  --files <map>     Feed path overrides: providerA=a.csv,providerB=b.xlsx
  --out <file>      Snapshot path (default: ${path.relative(ROOT, NORMALIZED_SNAPSHOT)})
  --dry-run         Normalize and report, but write nothing
  --strict          Fail (and write nothing) if any feed is missing or any row is rejected
`;

main("normalize-data", async () => {
  const opts = args(USAGE, {
    provider: { type: "string", multiple: true },
    files: { type: "string" },
    out: { type: "string" },
    "dry-run": { type: "boolean" },
    strict: { type: "boolean" },
  });

  const { feeds, failures } = await loadFeeds(opts.provider, parseFileOverrides(opts.files));
  for (const f of failures) console.warn(`⚠ ${f.providerId} skipped — ${f.code}: ${f.message}`);

  const importedAt = Date.now();
  const { astrologers, rejected } = normalizeFeeds(feeds, { importedAt });

  heading("Normalization summary");
  const accepted = countBy(astrologers, (a) => a.providerId);
  const dropped = countBy(rejected, (r) => r.providerId);
  console.table(
    Object.keys(feeds).map((providerId) => ({
      providerId,
      records: feeds[providerId].length,
      accepted: accepted.get(providerId) ?? 0,
      rejected: dropped.get(providerId) ?? 0,
    })),
  );
  if (rejected.length) {
    console.log("Rejected:");
    for (const r of rejected.slice(0, 15)) console.log(`  ${r.providerId} ${r.ref} [${r.stage}] ${r.issues.map((i) => `${i.path} ${i.message}`).join("; ")}`);
    if (rejected.length > 15) console.log(`  … ${rejected.length - 15} more in rejected.json`);
  }

  if (opts.strict && (failures.length || rejected.length)) {
    console.error("\n--strict: not writing snapshot.");
    return 1;
  }
  if (astrologers.length === 0) {
    console.error("\nNo astrologers normalized — refusing to overwrite the snapshot with an empty list.");
    return 1;
  }
  if (opts["dry-run"]) {
    console.log("\n--dry-run: nothing written.");
    return 0;
  }

  const out = opts.out ?? path.relative(ROOT, NORMALIZED_SNAPSHOT);
  const snapshot = await writeJson(out, astrologers);
  const rejectedFile = await writeJson(path.join(path.dirname(out), "rejected.json"), {
    importedAt: new Date(importedAt).toISOString(),
    feedFailures: failures,
    rejected,
  });
  console.log(`\nWrote ${astrologers.length} astrologers → ${snapshot}`);
  console.log(`Wrote ${rejected.length} rejections → ${rejectedFile}`);
  if (out !== path.relative(ROOT, NORMALIZED_SNAPSHOT)) {
    console.log("Note: the app reads the default snapshot path; this custom --out is not picked up automatically.");
  }
});
