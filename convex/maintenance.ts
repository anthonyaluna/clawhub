import { ConvexError, v } from 'convex/values'
import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import type { ActionCtx } from './_generated/server'
import { action, internalAction, internalMutation, internalQuery } from './_generated/server'
import { assertRole, requireUserFromAction } from './lib/access'
import { buildSkillSummaryBackfillPatch, type ParsedSkillData } from './lib/skillBackfill'

const DEFAULT_BATCH_SIZE = 50
const MAX_BATCH_SIZE = 200
const DEFAULT_MAX_BATCHES = 20
const MAX_MAX_BATCHES = 200

type BackfillStats = {
  skillsScanned: number
  skillsPatched: number
  versionsPatched: number
  missingLatestVersion: number
  missingReadme: number
  missingStorageBlob: number
}

type BackfillPageItem =
  | {
      kind: 'ok'
      skillId: Id<'skills'>
      versionId: Id<'skillVersions'>
      skillSummary: Doc<'skills'>['summary']
      versionParsed: Doc<'skillVersions'>['parsed']
      readmeStorageId: Id<'_storage'>
    }
  | { kind: 'missingLatestVersion'; skillId: Id<'skills'> }
  | { kind: 'missingVersionDoc'; skillId: Id<'skills'>; versionId: Id<'skillVersions'> }
  | { kind: 'missingReadme'; skillId: Id<'skills'>; versionId: Id<'skillVersions'> }

type BackfillPageResult = {
  items: BackfillPageItem[]
  cursor: string | null
  isDone: boolean
}

export const getSkillBackfillPageInternal = internalQuery({
  args: {
    cursor: v.optional(v.string()),
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<BackfillPageResult> => {
    const batchSize = clampInt(args.batchSize ?? DEFAULT_BATCH_SIZE, 1, MAX_BATCH_SIZE)
    const { page, isDone, continueCursor } = await ctx.db
      .query('skills')
      .order('asc')
      .paginate({ cursor: args.cursor ?? null, numItems: batchSize })

    const items: BackfillPageItem[] = []
    for (const skill of page) {
      if (!skill.latestVersionId) {
        items.push({ kind: 'missingLatestVersion', skillId: skill._id })
        continue
      }

      const version = await ctx.db.get(skill.latestVersionId)
      if (!version) {
        items.push({
          kind: 'missingVersionDoc',
          skillId: skill._id,
          versionId: skill.latestVersionId,
        })
        continue
      }

      const readmeFile = version.files.find(
        (file) => file.path.toLowerCase() === 'skill.md' || file.path.toLowerCase() === 'skills.md',
      )
      if (!readmeFile) {
        items.push({ kind: 'missingReadme', skillId: skill._id, versionId: version._id })
        continue
      }

      items.push({
        kind: 'ok',
        skillId: skill._id,
        versionId: version._id,
        skillSummary: skill.summary,
        versionParsed: version.parsed,
        readmeStorageId: readmeFile.storageId,
      })
    }

    return { items, cursor: continueCursor, isDone }
  },
})

export const applySkillBackfillPatchInternal = internalMutation({
  args: {
    skillId: v.id('skills'),
    versionId: v.id('skillVersions'),
    summary: v.optional(v.string()),
    parsed: v.optional(
      v.object({
        frontmatter: v.record(v.string(), v.any()),
        metadata: v.optional(v.any()),
        clawdis: v.optional(v.any()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const now = Date.now()
    if (typeof args.summary === 'string') {
      await ctx.db.patch(args.skillId, { summary: args.summary, updatedAt: now })
    }
    if (args.parsed) {
      await ctx.db.patch(args.versionId, { parsed: args.parsed })
    }
    return { ok: true as const }
  },
})

export type BackfillActionArgs = {
  dryRun?: boolean
  batchSize?: number
  maxBatches?: number
}

export type BackfillActionResult = { ok: true; stats: BackfillStats }

export async function backfillSkillSummariesInternalHandler(
  ctx: ActionCtx,
  args: BackfillActionArgs,
): Promise<BackfillActionResult> {
  const dryRun = Boolean(args.dryRun)
  const batchSize = clampInt(args.batchSize ?? DEFAULT_BATCH_SIZE, 1, MAX_BATCH_SIZE)
  const maxBatches = clampInt(args.maxBatches ?? DEFAULT_MAX_BATCHES, 1, MAX_MAX_BATCHES)

  const totals: BackfillStats = {
    skillsScanned: 0,
    skillsPatched: 0,
    versionsPatched: 0,
    missingLatestVersion: 0,
    missingReadme: 0,
    missingStorageBlob: 0,
  }

  let cursor: string | null = null
  let isDone = false

  for (let i = 0; i < maxBatches; i++) {
    const page = (await ctx.runQuery(internal.maintenance.getSkillBackfillPageInternal, {
      cursor: cursor ?? undefined,
      batchSize,
    })) as BackfillPageResult

    cursor = page.cursor
    isDone = page.isDone

    for (const item of page.items) {
      totals.skillsScanned++
      if (item.kind === 'missingLatestVersion') {
        totals.missingLatestVersion++
        continue
      }
      if (item.kind === 'missingVersionDoc') {
        totals.missingLatestVersion++
        continue
      }
      if (item.kind === 'missingReadme') {
        totals.missingReadme++
        continue
      }

      const blob = await ctx.storage.get(item.readmeStorageId)
      if (!blob) {
        totals.missingStorageBlob++
        continue
      }

      const readmeText = await blob.text()
      const patch = buildSkillSummaryBackfillPatch({
        readmeText,
        currentSummary: item.skillSummary ?? undefined,
        currentParsed: item.versionParsed as ParsedSkillData,
      })

      if (!patch.summary && !patch.parsed) continue
      if (patch.summary) totals.skillsPatched++
      if (patch.parsed) totals.versionsPatched++

      if (dryRun) continue

      await ctx.runMutation(internal.maintenance.applySkillBackfillPatchInternal, {
        skillId: item.skillId,
        versionId: item.versionId,
        summary: patch.summary,
        parsed: patch.parsed,
      })
    }

    if (isDone) break
  }

  if (!isDone) {
    throw new ConvexError('Backfill incomplete (maxBatches reached)')
  }

  return { ok: true as const, stats: totals }
}

export const backfillSkillSummariesInternal = internalAction({
  args: {
    dryRun: v.optional(v.boolean()),
    batchSize: v.optional(v.number()),
    maxBatches: v.optional(v.number()),
  },
  handler: backfillSkillSummariesInternalHandler,
})

export const backfillSkillSummaries: ReturnType<typeof action> = action({
  args: {
    dryRun: v.optional(v.boolean()),
    batchSize: v.optional(v.number()),
    maxBatches: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<BackfillActionResult> => {
    const { user } = await requireUserFromAction(ctx)
    assertRole(user, ['admin'])
    return ctx.runAction(
      internal.maintenance.backfillSkillSummariesInternal,
      args,
    ) as Promise<BackfillActionResult>
  },
})

export const scheduleBackfillSkillSummaries: ReturnType<typeof action> = action({
  args: { dryRun: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const { user } = await requireUserFromAction(ctx)
    assertRole(user, ['admin'])
    await ctx.scheduler.runAfter(0, internal.maintenance.backfillSkillSummariesInternal, {
      dryRun: Boolean(args.dryRun),
      batchSize: DEFAULT_BATCH_SIZE,
      maxBatches: DEFAULT_MAX_BATCHES,
    })
    return { ok: true as const }
  },
})

function clampInt(value: number, min: number, max: number) {
  const rounded = Math.trunc(value)
  if (!Number.isFinite(rounded)) return min
  return Math.min(max, Math.max(min, rounded))
}
