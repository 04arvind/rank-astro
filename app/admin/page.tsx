import type { ReactNode } from "react";
import AdminControls from "@/components/admin/controls/AdminControls";
import BanditComparison from "@/components/admin/BanditComparison";
import BanditPanel from "@/components/admin/BanditPanel";
import ProviderStats from "@/components/admin/ProviderStats";
import RankingPipeline, { type PipelineCandidate, type PipelineProvider } from "@/components/admin/RankingPipeline";
import ScoreBreakdownTable from "@/components/admin/ScoreBreakdownTable";
import { config } from "@/config";
import { getRankingStats } from "@/lib/analytics";
import { logError, toPublicError, ValidationError } from "@/lib/errors";
import { getRankingEngine } from "@/lib/ranking";
import { getBanditReport } from "@/lib/ranking/bandit";
import { cookies } from "next/headers";
import { VISITOR_COOKIE } from "@/components/astrologer/identity";
import type { CandidateDebug } from "@/types/ranking";
import { rankQuerySchema, statsQuerySchema } from "../api/_lib/schemas";

export const metadata = { title: "Ranking dashboard" };

type Settled<T> = { ok: true; value: T } | { ok: false; message: string };

async function settle<T>(p: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await p };
  } catch (err) {
    logError(err, { scope: "dashboard" });
    return { ok: false, message: toPublicError(err).message };
  }
}

function Unavailable({ title, message }: { title: string; message: string }) {
  return (
    <section className="rounded-xl border border-dashed border-zinc-300 bg-white p-6">
      <h2 className="font-semibold">{title}</h2>
      <p className="mt-1 text-sm text-zinc-500">{message}</p>
    </section>
  );
}

function Panel<T>({ title, result, render }: { title: string; result: Settled<T>; render: (value: T) => ReactNode }) {
  return result.ok ? render(result.value) : <Unavailable title={title} message={result.message} />;
}

/** Only what the pipeline view displays reaches the browser. */
function toPipelineCandidate(c: CandidateDebug): PipelineCandidate {
  return {
    id: c.astrologerId,
    name: c.astrologer?.name ?? c.astrologerId,
    providerId: c.providerId,
    pricePerMinute: c.astrologer?.pricePerMinute ?? null,
    online: c.astrologer?.isOnline ?? false,
    isExploration: c.isExploration ?? false,
    totalScore: c.breakdown?.totalScore ?? null,
    pillars: c.breakdown?.pillars,
    ml: c.ml,
    thompson: c.thompson,
    notes: c.adjustmentsNotes ?? [],
    exclusionReason: c.exclusionReason,
  };
}

const PIPELINE_PROVIDERS: PipelineProvider[] = config.providers.providers
  .filter((p) => p.enabled)
  .map((p) => ({ id: p.id, name: p.name, targetShare: p.targetShare, min: p.share.min, max: p.share.max }));

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const blank = (v: string | undefined) => (v ? v : undefined);

function Select({ name, label, value, options }: { name: string; label: string; value?: string; options: readonly { id: string; label: string }[] }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-zinc-500">{label}</span>
      <select name={name} defaultValue={value ?? ""} className="rounded border border-zinc-300 px-2 py-1">
        <option value="">Any</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export default async function DashboardPage(props: PageProps<"/admin">) {
  const sp = await props.searchParams;
  // No user id in the URL: rank as this browser's visitor, i.e. exactly what /user/astrologers shows here.
  // An explicit empty user id (cleared field) stays anonymous.
  const rawVisitor = (await cookies()).get(VISITOR_COOKIE)?.value;
  const visitor = (() => {
    try {
      return rawVisitor ? decodeURIComponent(rawVisitor) : undefined;
    } catch {
      return undefined; // malformed cookie: anonymous
    }
  })();
  const q = {
    window: first(sp.window),
    userId: sp.userId === undefined ? blank(visitor) : blank(first(sp.userId)?.trim()),
    languages: blank(first(sp.language)),
    category: blank(first(sp.category)),
    specialization: blank(first(sp.specialization)),
    onlineOnly: first(sp.onlineOnly) === "true" ? "true" : undefined,
  };

  // Same schemas as the API so the dashboard sees exactly what clients see.
  const statsQuery = statsQuerySchema.safeParse({ window: q.window });
  const rankCtx = rankQuerySchema.safeParse({ ...q, window: undefined, limit: String(config.ranking.pagination.maxLimit) });
  const window = statsQuery.success ? statsQuery.data.window : "24h";

  // Server-side: admin data never passes through the browser.
  const invalid = Promise.reject(new ValidationError("Invalid filters"));
  invalid.catch(() => {}); // settled later; avoid an unhandled-rejection warning
  const [stats, debug, bandit] = await Promise.all([
    settle(getRankingStats({ window })),
    settle(rankCtx.success ? getRankingEngine().debug(rankCtx.data) : invalid),
    settle(getBanditReport()),
  ]);

  return (
    <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-6 px-4 py-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-900">Ranking dashboard</h1>
          <p className="text-sm text-zinc-500">Simulate a request and inspect every score, booster and penalty behind the order.</p>
          <p className="text-xs text-zinc-400">
            {q.userId ? `Ranking as ${q.userId}${q.userId === visitor ? " — this browser's /user/astrologers visitor (same order)" : ""}` : "Ranking as an anonymous visitor"}
          </p>
        </div>

        <form className="flex flex-wrap items-end gap-2 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-zinc-500">User id</span>
            <input name="userId" defaultValue={q.userId ?? ""} placeholder="anonymous" className="w-36 rounded border border-zinc-300 px-2 py-1" />
          </label>
          <Select name="language" label="Language" value={q.languages} options={config.catalog.languages} />
          <Select name="category" label="Category" value={q.category} options={config.catalog.categories} />
          <Select name="specialization" label="Specialization" value={q.specialization} options={config.catalog.specializations} />
          <label className="flex items-center gap-1 pb-1.5">
            <input type="checkbox" name="onlineOnly" value="true" defaultChecked={q.onlineOnly === "true"} />
            <span>Online only</span>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-zinc-500">Stats window</span>
            <select name="window" defaultValue={window} className="rounded border border-zinc-300 px-2 py-1">
              {["1h", "24h", "7d", "30d"].map((w) => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="rounded bg-zinc-900 px-3 py-1.5 text-white">
            Apply
          </button>
        </form>
      </div>

      <AdminControls />
      <Panel
        title="Ranking pipeline"
        result={debug}
        render={(d) =>
          d.pipeline ? (
            <RankingPipeline pipeline={d.pipeline} candidates={d.candidates.map(toPipelineCandidate)} providers={PIPELINE_PROVIDERS} topN={config.business.guardrails.topN} />
          ) : (
            <Unavailable title="Ranking pipeline" message="This engine doesn't report a pipeline trace." />
          )
        }
      />
      <Panel title="Old ranking vs after bandit" result={debug} render={(d) => <BanditComparison
            candidates={d.candidates}
            firstSlot={config.ranking.bandit.firstSlot}
            slots={config.ranking.bandit.slots}
            mode={String(d.pipeline?.layers.find((l) => l.key === "exploration")?.details?.banditMode ?? "off")}
            variant={(d.pipeline?.layers.find((l) => l.key === "exploration")?.details?.variant as string | null | undefined) ?? null}
          />} />
      <Panel title="Ranking list" result={debug} render={(d) => <ScoreBreakdownTable candidates={d.candidates} engine={d.engine} pipeline={d.pipeline} />} />
      <Panel title="Provider utilization" result={stats} render={(s) => <ProviderStats stats={s} />} />
      <Panel title="Layer 5 — Thompson sampling" result={bandit} render={(r) => <BanditPanel report={r} />} />
    </main>
  );
}
