import { ConvexError } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";

type PublishFile = {
  path: string;
  storageId: Id<"_storage">;
  size: number;
  sha256: string;
};

export async function verifyPublishFiles<TFile extends PublishFile>(
  ctx: Pick<ActionCtx, "runQuery">,
  files: TFile[],
): Promise<TFile[]> {
  const metadata = await ctx.runQuery(internal.uploads.getFileMetadataInternal, {
    storageIds: files.map((file) => file.storageId),
  });
  return files.map((file, index) => {
    const stored = metadata[index];
    if (!stored) throw new ConvexError(`File "${file.path}" missing in storage`);
    if (file.size !== stored.size || file.sha256.toLowerCase() !== stored.sha256) {
      throw new ConvexError(`File "${file.path}" metadata does not match stored content`);
    }
    return { ...file, size: stored.size, sha256: stored.sha256 };
  });
}
