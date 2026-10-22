/**
 * Import & validate provider feeds (read-only).
 *
 *   npm run data:import -- [--provider providerA] [--files providerA=path.csv] [--report] [--strict]
 *
 * Loads each provider feed through its adapter, validates every record
 * against the common astrologer model, and prints a data-quality report:
 * accepted/rejected counts, rejection reasons, field coverage and values that
 * didn't map to the catalog. Writes nothing unless --report is given.
 * Contact details are never read, so reports contain no PII.
 */
import { normalizeProviderFeed } from "@/lib/astrologer";
import { countBy } from "@/lib/utils/collections";
import type { ProfileField } from "@/types/astrologer";
import { args, heading, main, pct, REPORTS_DIR, stamp, writeJson } from "./_lib/cli";
import { loadFeeds, parseFileOverrides } from "./_lib/data";

const USAGE = `
Usage: npm run data:import -- [options]

  --provider <id>     Only this provider (repeatable). Default: all configured.
  --files <map>       Feed path overrides: providerA=a.csv,providerB=b.xlsx
  --report            Also write reports/import-<timestamp>.json
  --strict            Exit 1 if any feed fails to load or any record is rejected
`;

const FIELDS: ProfileField[] = [
  "languages",
  "categories",
  "specializations",
  "experienceYears",
  "rating",
  "avatarUrl",
  "about",
  "availability",
  "consultationModes",
  "payout",
];

main("import-csv", async () => {
  const opts = args(USAGE, {
    provider: { type: "string", multiple: true },
    files: { type: "string" },
    report: { type: "boolean" },
    strict: { type: "boolean" },
  });

  const { feeds, failures } = await loadFeeds(opts.provider, parseFileOverrides(opts.files));
  const summary = [];

  for (const [providerId, records] of Object.entries(feeds)) {
    const { astrologers, rejected } = normalizeProviderFeed(providerId, records);
    heading(`${providerId}: ${records.length} records → ${astrologers.length} valid, ${rejected.length} rejected`);

    const byStage = countBy(rejected, (r) => r.stage);
    const byIssue = countBy(rejected.flatMap((r) => r.issues), (i) => `${i.path || "(root)"}: ${i.message}`);
    if (rejected.length) {
      console.log("Rejections by stage:", Object.fromEntries(byStage));
      console.table([...byIssue].sort((a, b) => b[1] - a[1]).map(([issue, count]) => ({ issue, count })));
      console.log("Rejected refs:", rejected.slice(0, 20).map((r) => r.ref).join(", "), rejected.length > 20 ? "…" : "");
    }

    const coverage = Object.fromEntries(
      FIELDS.map((f) => {
        const supplied = astrologers.filter((a) => !a.dataQuality.missing.includes(f)).length;
        return [f, astrologers.length ? supplied / astrologers.length : 0];
      }),
    );
    console.log("Field coverage:");
    console.table(Object.entries(coverage).map(([field, share]) => ({ field, supplied: pct(share, 0) })));

    const unmapped = countBy(astrologers.flatMap((a) => a.dataQuality.unmapped), (u) => u);
    if (unmapped.size) {
      console.log("Unmapped values (add aliases in config/catalog.config.ts):");
      console.table([...unmapped].map(([value, count]) => ({ value, count })));
    }

    const prices = astrologers.map((a) => a.pricing.perMinute).sort((a, b) => a - b);
    if (prices.length) {
      console.log(`Price/min: min ₹${prices[0]} · median ₹${prices[Math.floor(prices.length / 2)]} · max ₹${prices.at(-1)}`);
    }

    summary.push({
      providerId,
      records: records.length,
      valid: astrologers.length,
      rejected: rejected.length,
      rejectedByStage: Object.fromEntries(byStage),
      rejectionIssues: Object.fromEntries(byIssue),
      rejectedRefs: rejected.map((r) => r.ref),
      coverage,
      unmapped: Object.fromEntries(unmapped),
      verified: astrologers.filter((a) => a.verified).length,
    });
  }

  if (failures.length) {
    heading("Feeds that could not be loaded");
    console.table(failures);
  }

  if (opts.report) {
    const file = await writeJson(`${REPORTS_DIR}/import-${stamp()}.json`, { generatedAt: new Date().toISOString(), providers: summary, failures });
    console.log(`\nReport written to ${file}`);
  }

  const problems = failures.length + summary.reduce((s, p) => s + p.rejected, 0);
  return opts.strict && problems > 0 ? 1 : 0;
});
