import { getAuthUserId } from "@convex-dev/auth/server";
import { describe, expect, it, vi } from "vitest";
import { addMember, removeMember } from "./publishers";

vi.mock("@convex-dev/auth/server", () => ({ getAuthUserId: vi.fn() }));
vi.mock("./lib/publishers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/publishers")>()),
  ensurePersonalPublisherForUser: vi.fn(),
}));

type Role = "owner" | "admin" | "publisher";
type Row = { _id: string; [key: string]: unknown };
type Handler<T> = { _handler: (ctx: unknown, args: T) => Promise<unknown> };
const add = (
  addMember as unknown as Handler<{ publisherId: string; userHandle: string; role: Role }>
)._handler;
const remove = (removeMember as unknown as Handler<{ publisherId: string; userId: string }>)
  ._handler;

function fixture(roles: Record<string, Role>, actor: string) {
  const users = new Map<string, Row>();
  const members = new Map<string, Row>();
  for (const [handle, role] of Object.entries(roles)) {
    users.set(`users:${handle}`, { _id: `users:${handle}`, handle });
    members.set(`members:${handle}`, {
      _id: `members:${handle}`,
      publisherId: "publishers:org",
      userId: `users:${handle}`,
      role,
    });
  }
  const publisher = { _id: "publishers:org", kind: "org", handle: "org" };
  vi.mocked(getAuthUserId).mockResolvedValue(`users:${actor}` as never);
  const db = {
    get: vi.fn(async (id: string) => (id === publisher._id ? publisher : users.get(id))),
    query: vi.fn((table: string) => ({
      withIndex: vi.fn((_index: string, configure: (q: unknown) => void) => {
        const filters: Array<[string, unknown]> = [];
        const q = {
          eq: (field: string, value: unknown) => {
            filters.push([field, value]);
            return q;
          },
        };
        configure(q);
        const rows = () =>
          [...(table === "users" ? users : members).values()].filter((row) =>
            filters.every(([field, value]) => row[field] === value),
          );
        return {
          unique: async () => rows()[0] ?? null,
          collect: async () => rows(),
          async *[Symbol.asyncIterator]() {
            yield* rows();
          },
        };
      }),
    })),
    patch: vi.fn(async (id: string, fields: Record<string, unknown>) => {
      const member = members.get(id);
      if (!member) throw new Error(`Unknown member ${id}`);
      Object.assign(member, fields);
    }),
    delete: vi.fn(async (id: string) => {
      members.delete(id);
    }),
    insert: vi.fn(async () => "audit:synthetic"),
    replace: vi.fn(),
    normalizeId: vi.fn(),
  };
  return { ctx: { db }, members, db };
}

describe("organization owner role transitions", () => {
  it.each(["admin", "publisher"] as const)(
    "blocks an admin demoting an owner to %s",
    async (role) => {
      const { ctx, db, members } = fixture({ owner: "owner", admin: "admin" }, "admin");
      await expect(
        add(ctx, { publisherId: "publishers:org", userHandle: "owner", role }),
      ).rejects.toThrow("Only org owners can demote owners");
      expect(members.get("members:owner")?.role).toBe("owner");
      expect(db.patch).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    },
  );

  it.each(["admin", "publisher"] as const)(
    "blocks the final owner demoting itself to %s",
    async (role) => {
      const { ctx, members, db } = fixture({ owner: "owner", admin: "admin" }, "owner");
      await expect(
        add(ctx, { publisherId: "publishers:org", userHandle: "owner", role }),
      ).rejects.toThrow("Publisher must have at least one owner");
      expect(members.get("members:owner")?.role).toBe("owner");
      expect(db.patch).not.toHaveBeenCalled();
    },
  );

  it("allows an owner to demote a non-final owner and records the change", async () => {
    const { ctx, members, db } = fixture({ owner: "owner", other: "owner" }, "owner");
    await expect(
      add(ctx, { publisherId: "publishers:org", userHandle: "other", role: "admin" }),
    ).resolves.toEqual({ ok: true });
    expect(members.get("members:other")?.role).toBe("admin");
    expect(db.insert).toHaveBeenCalledWith(
      "auditLogs",
      expect.objectContaining({ action: "publisher.member.upsert" }),
    );
  });

  it("preserves an unchanged final-owner role", async () => {
    const { ctx, members } = fixture({ owner: "owner" }, "owner");
    await expect(
      add(ctx, { publisherId: "publishers:org", userHandle: "owner", role: "owner" }),
    ).resolves.toEqual({ ok: true });
    expect(members.get("members:owner")?.role).toBe("owner");
  });

  it("preserves admin management of non-owner members", async () => {
    const { ctx, members } = fixture(
      { owner: "owner", admin: "admin", member: "publisher" },
      "admin",
    );
    await expect(
      add(ctx, { publisherId: "publishers:org", userHandle: "member", role: "admin" }),
    ).resolves.toEqual({ ok: true });
    expect(members.get("members:member")?.role).toBe("admin");
  });

  it("preserves owner promotion of a non-owner member", async () => {
    const { ctx, members } = fixture({ owner: "owner", member: "publisher" }, "owner");
    await expect(
      add(ctx, { publisherId: "publishers:org", userHandle: "member", role: "owner" }),
    ).resolves.toEqual({ ok: true });
    expect(members.get("members:member")?.role).toBe("owner");
  });

  it("rechecks the owner invariant after a prior demotion", async () => {
    const { ctx, members } = fixture({ owner: "owner", other: "owner" }, "owner");
    await add(ctx, { publisherId: "publishers:org", userHandle: "other", role: "admin" });
    await expect(
      add(ctx, { publisherId: "publishers:org", userHandle: "owner", role: "admin" }),
    ).rejects.toThrow("Publisher must have at least one owner");
    expect(members.get("members:owner")?.role).toBe("owner");
  });

  it("preserves final-owner removal protection", async () => {
    const { ctx, db } = fixture({ owner: "owner" }, "owner");
    await expect(
      remove(ctx, { publisherId: "publishers:org", userId: "users:owner" }),
    ).rejects.toThrow("Publisher must have at least one owner");
    expect(db.delete).not.toHaveBeenCalled();
  });

  it("blocks the admin demote-then-remove sequence without writes", async () => {
    const { ctx, db, members } = fixture({ owner: "owner", admin: "admin" }, "admin");
    await expect(
      add(ctx, { publisherId: "publishers:org", userHandle: "owner", role: "publisher" }),
    ).rejects.toThrow("Only org owners can demote owners");
    await expect(
      remove(ctx, { publisherId: "publishers:org", userId: "users:owner" }),
    ).rejects.toThrow("Only org owners can remove other owners");
    expect(members.get("members:owner")?.role).toBe("owner");
    expect(db.patch).not.toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });
});
