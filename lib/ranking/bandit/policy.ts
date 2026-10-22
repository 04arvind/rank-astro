import { config } from "@/config";
import { logError } from "@/lib/errors";
import { hashUnit } from "@/lib/utils/math";
import type { AstrologerProfile } from "@/types/astrologer";
import type { RankingContext } from "@/types/ranking";
import { armIdsFor, contextKeyOf, type Posterior } from "./posterior";
import { getBanditStore } from "./store";
import type { ArmStats, BanditMode, BanditVariant } from "./types";

/*
 * Request-time state for Layer 3: which mode is in force, which variant the
 * viewer is in, and the persisted posterior counters for the candidates.
 * Loaded inside runRanking as an optional stage (any failure keeps the
 * Layer-2 order, see rank.ts); the sampling itself is in rerank.ts.
 */

const MODES: readonly BanditMode[] = ["off", "shadow", "live"];
const FLAG_KEY = "flags";

export interface BanditFlags {
  mode: BanditMode | null;
  updatedAt: number;
  updatedBy?: string;
}

export interface ModeResolution {
  mode: BanditMode;
  source: "env" | "admin" | "config";
}

const g = globalThis as unknown as {
  __banditFlags?: { at: number; flags: BanditFlags | null };
  __banditArms?: Map<string, { at: number; arm: ArmStats | null }>;
};
const armCache = (g.__banditArms ??= new Map());

/** Drops cached flags and posteriors (tests, after a rebuild or a mode change). */
export function resetBanditCache(): void {
  g.__banditFlags = undefined;
  armCache.clear();
}

/** BANDIT_MODE (deploy-time kill switch) > admin flag (runtime, persisted) > config. */
export async function resolveMode(now = Date.now()): Promise<ModeResolution> {
  const env = process.env.BANDIT_MODE?.trim().toLowerCase() as BanditMode | undefined;
  if (env && MODES.includes(env)) return { mode: env, source: "env" };

  const cached = g.__banditFlags;
  let flags = cached && now - cached.at < config.ranking.bandit.cacheSeconds * 1000 ? cached.flags : undefined;
  if (flags === undefined) {
    try {
      flags = await getBanditStore().getMeta<BanditFlags>(FLAG_KEY);
    } catch (err) {
      logError(err, { scope: "bandit", operation: "loadFlags" });
      flags = cached?.flags ?? null;
    }
    g.__banditFlags = { at: now, flags };
  }
  if (flags?.mode && MODES.includes(flags.mode)) return { mode: flags.mode, source: "admin" };
  return { mode: config.ranking.bandit.mode, source: "config" };
}

/** Admin runtime switch; null returns control to config. Effective within cacheSeconds on every process. */
export async function setModeFlag(mode: BanditMode | null, by: string | undefined, now = Date.now()): Promise<void> {
  await getBanditStore().setMeta<BanditFlags>(FLAG_KEY, { mode, updatedAt: now, updatedBy: by });
  g.__banditFlags = { at: now, flags: { mode, updatedAt: now, updatedBy: by } };
}

/** Who the posterior is learned for: the user, else the session. Null: can't be attributed. */
export const viewerKeyOf = (user: RankingContext["user"]) => user.userId ?? user.sessionId ?? null;

/** Deterministic per viewer and policy, so a viewer stays in one arm of the experiment. */
export function variantOf(viewerKey: string | null, policy = config.ranking.bandit.policyVersion, holdoutShare = config.ranking.bandit.holdoutShare): BanditVariant {
  if (viewerKey === null || holdoutShare <= 0) return "treatment";
  return hashUnit(`holdout:${policy}:${viewerKey}`) < holdoutShare ? "control" : "treatment";
}

export interface BanditDecision {
  sample: number;
  posterior: Posterior;
  /** Expected ₹ margin of one consultation with this astrologer. */
  marginPerConsultation: number;
  /** What the slots are filled by: the sample turned into the configured objective, × fairness. */
  reward: number;
  /** Fair-exposure multiplier in the reward (1 = none; config bandit.fairness). */
  fairness: number;
  /** Layer-2 position, and the position after Layer 3. */
  layer2Rank: number;
  rank: number;
}

/** Loaded before ranking: mode, experiment variant, arms. */
export interface BanditState {
  mode: Exclude<BanditMode, "off">;
  modeSource: ModeResolution["source"];
  policy: string;
  variant: BanditVariant;
  context: string;
  viewerKey: string | null;
  /** Seed for this viewer, context and time bucket. */
  seed: string;
  arms: ReadonlyMap<string, ArmStats>;
}

/** After Layer 3: the state plus one decision per sampled candidate. */
export interface BanditContext extends Omit<BanditState, "arms"> {
  decisions: ReadonlyMap<string, BanditDecision>;
}

async function loadArms(ids: readonly string[], now: number): Promise<Map<string, ArmStats>> {
  const ttl = config.ranking.bandit.cacheSeconds * 1000;
  const out = new Map<string, ArmStats>();
  const missing: string[] = [];
  for (const id of new Set(ids)) {
    const hit = armCache.get(id);
    if (hit && now - hit.at < ttl) {
      if (hit.arm) out.set(id, hit.arm);
    } else missing.push(id);
  }
  if (missing.length) {
    const fetched = new Map((await getBanditStore().getArms(missing)).map((a) => [a.id, a]));
    for (const id of missing) {
      const arm = fetched.get(id) ?? null;
      armCache.set(id, { at: now, arm });
      if (arm) out.set(id, arm);
    }
  }
  return out;
}

/**
 * Mode, variant and arm counters for the candidates; undefined when the
 * bandit is off. Samples are seeded by viewer + context + time bucket, so a
 * viewer's list is stable on refresh for sampleStableSeconds.
 */
export async function loadBanditState(candidates: readonly AstrologerProfile[], ctx: RankingContext, now: number): Promise<BanditState | undefined> {
  const cfg = config.ranking.bandit;
  const { mode, source } = await resolveMode(now);
  if (mode === "off") return undefined;

  const policy = cfg.policyVersion;
  const context = contextKeyOf(ctx.context.category);
  const viewerKey = viewerKeyOf(ctx.user);
  const arms = await loadArms(candidates.flatMap((a) => armIdsFor(a, context, policy)), now);
  const bucket = Math.floor(now / (cfg.sampleStableSeconds * 1000));
  return {
    mode,
    modeSource: source,
    policy,
    variant: variantOf(viewerKey, policy),
    context,
    viewerKey,
    seed: `${policy}:${viewerKey ?? "anon"}:${context}:${bucket}`,
    arms,
  };
}
