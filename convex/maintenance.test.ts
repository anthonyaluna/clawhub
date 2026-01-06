/* @vitest-environment node */
import { describe, expect, it, vi } from 'vitest'

vi.mock('./_generated/api', () => ({
  internal: {
    maintenance: {
      getSkillBackfillPageInternal: Symbol('getSkillBackfillPageInternal'),
      applySkillBackfillPatchInternal: Symbol('applySkillBackfillPatchInternal'),
      backfillSkillSummariesInternal: Symbol('backfillSkillSummariesInternal'),
    },
  },
}))

const { backfillSkillSummariesInternalHandler } = await import('./maintenance')

function makeBlob(text: string) {
  return { text: () => Promise.resolve(text) } as unknown as Blob
}

describe('maintenance backfill', () => {
  it('repairs summary + parsed by reparsing SKILL.md', async () => {
    const runQuery = vi.fn().mockResolvedValue({
      items: [
        {
          kind: 'ok',
          skillId: 'skills:1',
          versionId: 'skillVersions:1',
          skillSummary: '>',
          versionParsed: { frontmatter: { description: '>' } },
          readmeStorageId: 'storage:1',
        },
      ],
      cursor: null,
      isDone: true,
    })

    const runMutation = vi.fn().mockResolvedValue({ ok: true })
    const storageGet = vi
      .fn()
      .mockResolvedValue(makeBlob(`---\ndescription: >\n  Hello\n  world.\n---\nBody`))

    const result = await backfillSkillSummariesInternalHandler(
      { runQuery, runMutation, storage: { get: storageGet } } as never,
      { dryRun: false, batchSize: 10, maxBatches: 1 },
    )

    expect(result.ok).toBe(true)
    expect(result.stats.skillsScanned).toBe(1)
    expect(result.stats.skillsPatched).toBe(1)
    expect(result.stats.versionsPatched).toBe(1)
    expect(runMutation).toHaveBeenCalledTimes(1)
    expect(runMutation).toHaveBeenCalledWith(expect.anything(), {
      skillId: 'skills:1',
      versionId: 'skillVersions:1',
      summary: 'Hello world.',
      parsed: {
        frontmatter: { description: 'Hello world.' },
        metadata: undefined,
        clawdis: undefined,
      },
    })
  })

  it('dryRun does not patch', async () => {
    const runQuery = vi.fn().mockResolvedValue({
      items: [
        {
          kind: 'ok',
          skillId: 'skills:1',
          versionId: 'skillVersions:1',
          skillSummary: '>',
          versionParsed: { frontmatter: { description: '>' } },
          readmeStorageId: 'storage:1',
        },
      ],
      cursor: null,
      isDone: true,
    })

    const runMutation = vi.fn()
    const storageGet = vi.fn().mockResolvedValue(makeBlob(`---\ndescription: Hello\n---\nBody`))

    const result = await backfillSkillSummariesInternalHandler(
      { runQuery, runMutation, storage: { get: storageGet } } as never,
      { dryRun: true, batchSize: 10, maxBatches: 1 },
    )

    expect(result.ok).toBe(true)
    expect(result.stats.skillsPatched).toBe(1)
    expect(runMutation).not.toHaveBeenCalled()
  })

  it('counts missing storage blob', async () => {
    const runQuery = vi.fn().mockResolvedValue({
      items: [
        {
          kind: 'ok',
          skillId: 'skills:1',
          versionId: 'skillVersions:1',
          skillSummary: null,
          versionParsed: { frontmatter: {} },
          readmeStorageId: 'storage:missing',
        },
      ],
      cursor: null,
      isDone: true,
    })

    const runMutation = vi.fn()
    const storageGet = vi.fn().mockResolvedValue(null)

    const result = await backfillSkillSummariesInternalHandler(
      { runQuery, runMutation, storage: { get: storageGet } } as never,
      { dryRun: false, batchSize: 10, maxBatches: 1 },
    )

    expect(result.stats.missingStorageBlob).toBe(1)
    expect(runMutation).not.toHaveBeenCalled()
  })
})
