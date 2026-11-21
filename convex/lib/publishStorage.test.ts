/* @vitest-environment node */
import { createHash } from "node:crypto";
import { getFunctionName, type FunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCtx } from "../_generated/server";
import * as uploads from "../uploads";
import { publishVersionForUser } from "./skillPublish";
import { publishSoulVersionForUser } from "./soulPublish";

vi.mock("./embeddings", () => ({ generateEmbedding: async () => [0.25, 0.75] }));

const HELLO_SHA256 = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
const OWNER = {
  _id: "users:1",
  _creationTime: 1,
  createdAt: 1,
  githubCreatedAt: 1,
  handle: "publisher",
  role: "user",
};

type File = {
  path: string;
  size: number;
  sha256: string;
  storageId: string;
  contentType?: string;
};
type StoredFile = {
  _id: string;
  _creationTime: number;
  size: number;
  sha256: string;
  contentType?: string;
};

function makeCtx(stored: Map<string, StoredFile>) {
  const reads: string[] = [];
  const versions: Array<Record<string, unknown>> = [];
  const ctx = {
    runQuery: async (query: FunctionReference<"query">, args: Record<string, unknown>) => {
      const name = getFunctionName(query);
      if (name === "users:getByIdInternal") return OWNER;
      if (name === "skills:getSkillBySlugInternal" || name === "souls:getSoulBySlugInternal") {
        return null;
      }
      if (name === "uploads:getFileMetadataInternal") {
        const endpoint = (uploads as unknown as Record<string, { _handler: Function }>)[
          "getFileMetadataInternal"
        ];
        return endpoint._handler(
          {
            db: {
              system: {
                get: async (table: string, id: string) => {
                  if (table !== "_storage") throw new Error("Unexpected system table");
                  return stored.get(id) ?? null;
                },
              },
            },
          },
          args,
        );
      }
      throw new Error(`Unexpected query ${name}`);
    },
    runMutation: async (mutation: FunctionReference<"mutation">, args: Record<string, unknown>) => {
      const name = getFunctionName(mutation);
      if (name === "skills:insertVersion" || name === "souls:insertVersion") {
        versions.push(args);
        return { versionId: "versions:1", skillId: "skills:1", soulId: "souls:1" };
      }
      if (name === "securityScan:enqueueSkillVersionScanInternal") return null;
      throw new Error(`Unexpected mutation ${name}`);
    },
    storage: {
      get: async (id: string) => {
        reads.push(id);
        return stored.has(id) ? new Blob(["hello"]) : null;
      },
    },
    scheduler: { runAfter: async () => null },
  };
  return { ctx: ctx as unknown as ActionCtx, reads, versions };
}

describe.each(["skill", "soul"] as const)("%s stored-file integrity", (kind) => {
  beforeEach(() => vi.stubEnv("OPENAI_API_KEY", ""));
  afterEach(() => vi.unstubAllEnvs());

  function fixture() {
    const file: File = {
      path: kind === "skill" ? "SKILL.md" : "SOUL.md",
      size: 5,
      storageId: "_storage:1",
      sha256: HELLO_SHA256,
      contentType: "text/markdown",
    };
    const metadata: StoredFile = {
      _id: file.storageId,
      _creationTime: 1,
      size: 5,
      sha256: "LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=",
      contentType: "text/markdown",
    };
    const stored = new Map([[file.storageId, metadata]]);
    return { file, metadata, stored, ...makeCtx(stored) };
  }

  function publish(ctx: ActionCtx, files: File[]) {
    const args = {
      slug: "demo",
      displayName: "Demo",
      version: "1.0.0",
      changelog: "Initial release",
      files: files as never,
    };
    return kind === "skill"
      ? publishVersionForUser(ctx, OWNER._id as never, args, {
          bypassQualityGate: true,
          skipBackup: true,
          skipWebhook: true,
        })
      : publishSoulVersionForUser(ctx, OWNER._id as never, args);
  }

  it.each([-1, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects a false size of %s before reading content or inserting a version",
    async (size) => {
      const { ctx, file, reads, versions } = fixture();
      await expect(publish(ctx, [{ ...file, size }])).rejects.toThrow(/metadata.*match/i);
      expect(reads).toEqual([]);
      expect(versions).toEqual([]);
    },
  );

  it.each(["", "abc", "f".repeat(64)])("rejects a false digest %s", async (sha256) => {
    const { ctx, file, reads, versions } = fixture();
    await expect(publish(ctx, [{ ...file, sha256 }])).rejects.toThrow(/metadata.*match/i);
    expect(reads).toEqual([]);
    expect(versions).toEqual([]);
  });

  it("rejects an underreported oversized object before loading it", async () => {
    const { ctx, file, metadata, reads, versions } = fixture();
    metadata.size = 51 * 1024 * 1024;
    await expect(publish(ctx, [file])).rejects.toThrow(/metadata.*match/i);
    expect(reads).toEqual([]);
    expect(versions).toEqual([]);
  });

  it("rejects a missing stored object before content processing", async () => {
    const { ctx, file, stored, reads, versions } = fixture();
    stored.clear();
    await expect(publish(ctx, [file])).rejects.toThrow(/missing.*storage/i);
    expect(reads).toEqual([]);
    expect(versions).toEqual([]);
  });

  it("preserves a valid legacy publish and canonicalizes an uppercase digest", async () => {
    const { ctx, file, versions } = fixture();
    await publish(ctx, [{ ...file, sha256: HELLO_SHA256.toUpperCase() }]);
    expect(versions).toHaveLength(1);
    expect(versions[0].files).toEqual([file]);
    const expectedFingerprint = createHash("sha256")
      .update(`${file.path}:${HELLO_SHA256}`)
      .digest("hex");
    expect(versions[0].fingerprint).toBe(expectedFingerprint);
  });

  it("accepts the Convex backend's base64 storage digest and persists client hex", async () => {
    const { ctx, file, metadata, versions } = fixture();
    metadata.sha256 = "LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=";
    await publish(ctx, [file]);
    expect(versions[0].files).toEqual([file]);
  });

  it("rejects a forged client digest when stored metadata uses base64", async () => {
    const { ctx, file, metadata, reads, versions } = fixture();
    metadata.sha256 = "LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=";
    await expect(publish(ctx, [{ ...file, sha256: "f".repeat(64) }])).rejects.toThrow(
      /metadata.*match/i,
    );
    expect(reads).toEqual([]);
    expect(versions).toEqual([]);
  });

  it("enforces the existing bundle limit using authoritative metadata", async () => {
    const { ctx, file, metadata, reads, versions } = fixture();
    metadata.size = 51 * 1024 * 1024;
    await expect(publish(ctx, [{ ...file, size: metadata.size }])).rejects.toThrow(/limit/i);
    expect(reads).toEqual([]);
    expect(versions).toEqual([]);
  });
});
