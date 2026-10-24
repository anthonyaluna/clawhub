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
    const sha256 = storageDigestToHex(stored.sha256);
    if (file.size !== stored.size || file.sha256.toLowerCase() !== sha256) {
      throw new ConvexError(`File "${file.path}" metadata does not match stored content`);
    }
    return { ...file, size: stored.size, sha256 };
  });
}

function storageDigestToHex(digest: string) {
  // Convex's _storage virtual table uses base64 for SDK versions >= 1.9.0.
  // The legacy publish API and its existing clients use hex.
  let bytes: string;
  try {
    bytes = atob(digest);
  } catch {
    throw new ConvexError("Invalid file digest in storage");
  }
  if (bytes.length !== 32) throw new ConvexError("Invalid file digest in storage");
  return Array.from(bytes, (byte) => byte.charCodeAt(0).toString(16).padStart(2, "0")).join("");
}
