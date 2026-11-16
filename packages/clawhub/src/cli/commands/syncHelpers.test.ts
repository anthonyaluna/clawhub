/* @vitest-environment node */
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../scanSkills.js", () => ({
  findSkillFolders: vi.fn(async (root: string) => {
    if (root === resolve("/tmp/with-skill")) {
      return [{ folder: join(root, "demo"), slug: "demo", displayName: "Demo" }];
    }
    return [];
  }),
}));

const { scanRootsWithLabels } = await import("./syncHelpers.js");

describe("scanRootsWithLabels", () => {
  it("attaches labels to roots with skills", async () => {
    const skillRoot = resolve("/tmp/with-skill");
    const roots = [skillRoot, resolve("/tmp/empty"), skillRoot];
    const labels = { [skillRoot]: "Agent: Work" };

    const result = await scanRootsWithLabels(roots, labels);

    expect(result.rootsWithSkills).toEqual([skillRoot]);
    expect(result.rootLabels).toEqual({ [skillRoot]: "Agent: Work" });
    expect(result.skills.map((skill) => skill.slug)).toEqual(["demo"]);
  });
});
