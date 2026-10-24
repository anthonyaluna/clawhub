/* @vitest-environment node */

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createHttpClient } from "./http.js";

type SpawnResult = {
  status: number | null;
  stdout?: string;
  stderr?: string;
};

function createBunClient(options?: {
  spawnImpl?: (...args: unknown[]) => SpawnResult;
  mkdtempValue?: string;
  readFileValue?: Buffer | null;
}) {
  const spawnImpl = vi.fn(options?.spawnImpl ?? (() => ({ status: 0, stdout: "", stderr: "" })));
  const mkdirImpl = vi.fn(async () => undefined);
  const mkdtempImpl = vi.fn(async () => options?.mkdtempValue ?? "/tmp/clawhub-test");
  const rmImpl = vi.fn(async () => undefined);
  const writeFileImpl = vi.fn(async () => undefined);
  const readFileImpl = vi.fn(
    async () => (options?.readFileValue ?? Buffer.from([1, 2, 3])) as Buffer<ArrayBuffer>,
  );
  const setTimeoutImpl = vi.fn((callback: () => void, _ms?: number) => {
    callback();
    return 1 as unknown as ReturnType<typeof setTimeout>;
  });
  const clearTimeoutImpl = vi.fn();

  return {
    client: createHttpClient({
      runtime: "bun",
      configureDispatcher: false,
      spawnSyncImpl: spawnImpl as unknown as typeof import("node:child_process").spawnSync,
      mkdirImpl: mkdirImpl as unknown as typeof import("node:fs/promises").mkdir,
      mkdtempImpl: mkdtempImpl as unknown as typeof import("node:fs/promises").mkdtemp,
      rmImpl: rmImpl as unknown as typeof import("node:fs/promises").rm,
      writeFileImpl: writeFileImpl as unknown as typeof import("node:fs/promises").writeFile,
      readFileImpl: readFileImpl as unknown as typeof import("node:fs/promises").readFile,
      setTimeoutImpl: setTimeoutImpl as unknown as typeof setTimeout,
      clearTimeoutImpl,
      tmpdirPath: "/tmp",
      random: () => 0,
    }),
    spawnImpl,
    mkdirImpl,
    mkdtempImpl,
    rmImpl,
    writeFileImpl,
    readFileImpl,
    setTimeoutImpl,
    clearTimeoutImpl,
  };
}

async function readMultipartUpload(stubs: ReturnType<typeof createBunClient>, attempt = 0) {
  const [command, args] = stubs.spawnImpl.mock.calls[attempt] as [string, string[]];
  expect(command).toBe("curl");
  // Assert the security boundary before decoding the actual uploaded bytes.
  expect(args).not.toContain("-F");
  expect(args).not.toContain("--form");
  expect(args).not.toContain("--form-string");
  const bodyIndex = args.indexOf("--data-binary");
  expect(bodyIndex).toBeGreaterThanOrEqual(0);
  const writes = stubs.writeFileImpl.mock.calls as unknown as [string, Uint8Array][];
  const [bodyPath, bytes] = writes[attempt];
  expect(args[bodyIndex + 1]).toBe(`@${bodyPath}`);
  const headers = new Headers();
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "-H") continue;
    const header = args[index + 1];
    const colon = header.indexOf(":");
    headers.append(header.slice(0, colon), header.slice(colon + 1).trim());
  }
  expect(headers.get("Content-Type")).toMatch(/^multipart\/form-data; boundary=/);
  const form = await new Response(new Uint8Array(bytes), { headers }).formData();
  return { form, args, bodyPath, headers };
}

describe("bun http client", () => {
  it("uses curl for apiRequest GET and POST", async () => {
    const { client, spawnImpl } = createBunClient({
      spawnImpl: () => ({ status: 0, stdout: '{"ok":true}\n200', stderr: "" }),
    });

    const getResult = await client.apiRequest<{ ok: boolean }>("https://registry.example", {
      method: "GET",
      path: "/v1/ping",
      token: "clh_token",
    });
    await client.apiRequest("https://registry.example", {
      method: "POST",
      path: "/v1/ping",
      body: { a: 1 },
    });

    expect(getResult).toEqual({ ok: true });
    const [, getArgs] = spawnImpl.mock.calls[0] as [string, string[]];
    expect(getArgs).toContain("GET");
    expect(getArgs).toContain("https://registry.example/v1/ping");
    expect(getArgs).toContain("Authorization: Bearer clh_token");

    const [, postArgs] = spawnImpl.mock.calls[1] as [string, string[]];
    expect(postArgs).toContain("Content-Type: application/json");
    expect(postArgs).toContain("--data-binary");
    expect(postArgs).toContain('{"a":1}');
  });

  it("parses explicitly accepted non-2xx json responses via curl", async () => {
    const { client, spawnImpl } = createBunClient({
      spawnImpl: () => ({
        status: 0,
        stdout:
          '{"ok":false,"message":"GitHub-backed skill changed upstream; waiting for scan."}\n409',
        stderr: "",
      }),
    });

    await expect(
      client.apiRequest("https://registry.example", {
        method: "GET",
        path: "/v1/skills/demo/install",
        acceptedStatuses: [409],
      }),
    ).resolves.toEqual({
      ok: false,
      message: "GitHub-backed skill changed upstream; waiting for scan.",
    });
    expect(spawnImpl).toHaveBeenCalledTimes(1);
  });

  it("retries 429 responses and keeps 404 non-retryable", async () => {
    const rateLimited = createBunClient({
      spawnImpl: () => ({ status: 0, stdout: "rate limited\n429", stderr: "" }),
    });

    await expect(
      rateLimited.client.apiRequest("https://registry.example", {
        method: "GET",
        path: "/v1/ping",
      }),
    ).rejects.toThrow("rate limited");
    expect(rateLimited.spawnImpl).toHaveBeenCalledTimes(3);

    const missing = createBunClient({
      spawnImpl: () => ({ status: 0, stdout: "missing\n404", stderr: "" }),
    });
    await expect(
      missing.client.apiRequest("https://registry.example", {
        method: "GET",
        path: "/v1/ping",
      }),
    ).rejects.toThrow("missing");
    expect(missing.spawnImpl).toHaveBeenCalledTimes(1);
  });

  it("includes curl rate-limit metadata in 429 errors", async () => {
    const { client, spawnImpl } = createBunClient({
      spawnImpl: () => ({
        status: 0,
        stdout: "rate limited\n__CLAWHUB_CURL_META__\n429\n20\n0\n1771404540\n20\n0\n34\n34\n",
        stderr: "",
      }),
    });

    await expect(
      client.apiRequest("https://registry.example", {
        method: "GET",
        path: "/v1/ping",
      }),
    ).rejects.toThrow(/retry in 34s.*remaining: 0\/20.*reset in 34s/i);
    expect(spawnImpl).toHaveBeenCalledTimes(3);
  });

  it("supports fetchText and downloadZip via curl", async () => {
    const { client, spawnImpl, readFileImpl, rmImpl } = createBunClient({
      spawnImpl: vi
        .fn()
        .mockReturnValueOnce({ status: 0, stdout: "hello world\n200", stderr: "" })
        .mockReturnValueOnce({ status: 0, stdout: "200", stderr: "" })
        .mockReturnValueOnce({ status: 0, stdout: "404", stderr: "" }),
      mkdtempValue: "/tmp/clawhub-download-abc",
      readFileValue: Buffer.from("not found"),
    });

    await expect(
      client.fetchText("https://registry.example", { path: "/v1/readme" }),
    ).resolves.toBe("hello world");
    const bytes = await client.downloadZip("https://registry.example", {
      slug: "demo",
      token: "t",
    });
    expect(Array.from(bytes)).toEqual(Array.from(Buffer.from("not found")));
    await expect(
      client.downloadZip("https://registry.example", { slug: "demo", token: "t" }),
    ).rejects.toThrow("not found");

    expect(readFileImpl).toHaveBeenCalled();
    expect(rmImpl).toHaveBeenCalledWith("/tmp/clawhub-download-abc", {
      recursive: true,
      force: true,
    });
    expect(spawnImpl).toHaveBeenCalledTimes(3);
  });

  it("posts multipart form data via curl and cleans up temp files", async () => {
    const stubs = createBunClient({
      spawnImpl: () => ({ status: 0, stdout: '{"ok":true}\n200', stderr: "" }),
      mkdtempValue: "/tmp/clawhub-upload-abc",
    });

    const form = new FormData();
    form.append("name", "demo");
    form.append("file", new Blob(["abc"], { type: "text/plain" }), "dist/demo.txt");

    const result = await stubs.client.apiRequestForm<{ ok: boolean }>("https://registry.example", {
      method: "POST",
      path: "/upload",
      form,
    });

    expect(result).toEqual({ ok: true });
    const upload = await readMultipartUpload(stubs);
    expect(upload.form.get("name")).toBe("demo");
    const file = upload.form.get("file") as File;
    expect(file.name).toBe("dist/demo.txt");
    expect(file.type).toBe("text/plain");
    expect(await file.text()).toBe("abc");
    expect(stubs.mkdirImpl).not.toHaveBeenCalled();
    expect(stubs.writeFileImpl).toHaveBeenCalledTimes(1);
    expect(stubs.rmImpl).toHaveBeenCalledWith("/tmp/clawhub-upload-abc", {
      recursive: true,
      force: true,
    });
  });

  it.each([
    "@synthetic-canary.txt",
    "<synthetic-canary.txt",
    "value;headers=@synthetic-canary.txt",
    "value;type=text/plain;filename=extra.txt",
    " leading and trailing spaces ",
  ])("keeps scalar multipart data literal: %s", async (value) => {
    const stubs = createBunClient({
      spawnImpl: () => ({ status: 0, stdout: '{"ok":true}\n200', stderr: "" }),
    });
    const form = new FormData();
    form.append("clawpack", value);
    form.append("clawpackUploadTicket", value);
    form.append("payload", '{"name":"ordinary-control"}');

    await stubs.client.apiRequestForm("https://registry.example", {
      method: "POST",
      path: "/upload",
      form,
    });

    const upload = await readMultipartUpload(stubs);
    expect(upload.form.get("clawpack")).toBe(value);
    expect(upload.form.get("clawpackUploadTicket")).toBe(value);
    expect(upload.form.get("payload")).toBe('{"name":"ordinary-control"}');
    expect(stubs.writeFileImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    "dist/demo.txt",
    "comma,name.txt",
    "semi;headers=@synthetic-canary.txt",
    'quote";filename=extra.txt',
    "back\\slash.txt",
    "line\r\nbreak.txt",
    "../outside.txt",
    "C:\\outside.txt",
  ])(
    "does not let display filenames control local reads or staging paths: %s",
    async (filename) => {
      const tempDir = join("synthetic-temp", "clawhub-upload-abc");
      const stubs = createBunClient({
        spawnImpl: () => ({ status: 0, stdout: '{"ok":true}\n200', stderr: "" }),
        mkdtempValue: tempDir,
      });
      const form = new FormData();
      form.append(
        "files",
        new Blob([new Uint8Array([0, 10, 255])], { type: "application/octet-stream" }),
        filename,
      );

      await stubs.client.apiRequestForm("https://registry.example", {
        method: "POST",
        path: "/upload",
        form,
      });

      const upload = await readMultipartUpload(stubs);
      expect(dirname(upload.bodyPath)).toBe(tempDir);
      expect(upload.args.join("\n")).not.toContain(filename);
      const file = upload.form.get("files") as File;
      expect(file.name).toBe(filename);
      expect(file.type).toBe("application/octet-stream");
      expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([0, 10, 255]));
      expect(stubs.writeFileImpl).toHaveBeenCalledTimes(1);
      expect(stubs.mkdirImpl).not.toHaveBeenCalled();
      expect(stubs.rmImpl).toHaveBeenCalledWith(tempDir, { recursive: true, force: true });
    },
  );

  it("preserves repeated scalars and distinct bytes for duplicate display filenames", async () => {
    const stubs = createBunClient({
      spawnImpl: () => ({ status: 0, stdout: '{"ok":true}\n200', stderr: "" }),
      mkdtempValue: 'C:\\synthetic temp,semicolon;quote"\\upload',
    });
    const form = new FormData();
    form.append("tag", "first");
    form.append("tag", "second");
    form.append("files", new Blob(["first bytes"], { type: "text/plain" }), "dist/same.txt");
    form.append("files", new Blob(["second bytes"], { type: "text/plain" }), "dist/same.txt");

    await stubs.client.apiRequestForm("https://registry.example", {
      method: "POST",
      path: "/upload",
      token: "synthetic-token",
      form,
    });

    const upload = await readMultipartUpload(stubs);
    expect(upload.form.getAll("tag")).toEqual(["first", "second"]);
    const files = upload.form.getAll("files") as File[];
    expect(files.map((file) => file.name)).toEqual(["dist/same.txt", "dist/same.txt"]);
    expect(await Promise.all(files.map((file) => file.text()))).toEqual([
      "first bytes",
      "second bytes",
    ]);
    expect(files.map((file) => file.type)).toEqual(["text/plain", "text/plain"]);
    expect(upload.headers.get("Authorization")).toBe("Bearer synthetic-token");
    expect(upload.args).toContain("120");
    expect(stubs.writeFileImpl).toHaveBeenCalledTimes(1);
  });

  it("encodes a real Bun request that the independent Node multipart parser can read", async () => {
    const fixture = fileURLToPath(
      new URL("../test-artifact/fixtures/multipart-runtime.mjs", import.meta.url),
    );
    const result = spawnSync("bun", [fixture], { encoding: "utf8", timeout: 15_000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const packet = JSON.parse(result.stdout);
    expect(packet.bun).toBeTruthy();
    const headers = new Headers(packet.headers);
    expect(headers.get("Authorization")).toBe("Bearer synthetic-token");
    const form = await new Response(Buffer.from(packet.bytes, "base64"), { headers }).formData();
    expect(form.getAll("tag")).toEqual([
      "@synthetic-canary.txt",
      "<synthetic-canary.txt",
      "value;headers=@synthetic-canary.txt",
    ]);
    const files = form.getAll("files") as File[];
    expect(files.map((file) => file.name)).toEqual([
      "dist/demo.txt",
      "comma,name.txt",
      "semi;headers=@synthetic-canary.txt",
      'quote";filename=extra.txt',
      "back\\slash.txt",
      "line\r\nbreak.txt",
      "../outside.txt",
      "C:\\outside.txt",
      "same.txt",
      "same.txt",
    ]);
    for (const [index, file] of files.entries()) {
      expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([index, 0, 255]));
      expect(file.type).toBe("application/octet-stream");
    }
  });

  it("retries form uploads with literal data and cleans each attempt", async () => {
    const stubs = createBunClient({
      spawnImpl: vi
        .fn()
        .mockReturnValueOnce({ status: 0, stdout: "rate limited\n429", stderr: "" })
        .mockReturnValueOnce({ status: 0, stdout: '{"ok":true}\n200', stderr: "" }),
    });
    const form = new FormData();
    form.append("payload", "<synthetic-canary.txt");

    await expect(
      stubs.client.apiRequestForm("https://registry.example", {
        method: "POST",
        path: "/upload",
        form,
      }),
    ).resolves.toEqual({ ok: true });

    expect((await readMultipartUpload(stubs, 0)).form.get("payload")).toBe("<synthetic-canary.txt");
    expect((await readMultipartUpload(stubs, 1)).form.get("payload")).toBe("<synthetic-canary.txt");
    expect(stubs.rmImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    { status: 1, stdout: "", stderr: "synthetic curl failure", error: "synthetic curl failure" },
    { status: 0, stdout: "denied\n403", stderr: "", error: "denied" },
    { status: 0, stdout: "invalid json\n200", stderr: "", error: "JSON" },
  ])("cleans form staging after failure: $error", async (result) => {
    const stubs = createBunClient({ spawnImpl: () => result });
    const form = new FormData();
    form.append("payload", "ordinary data");

    await expect(
      stubs.client.apiRequestForm("https://registry.example", {
        method: "POST",
        path: "/upload",
        form,
        retryCount: 0,
      }),
    ).rejects.toThrow(result.error);
    await readMultipartUpload(stubs);
    expect(stubs.rmImpl).toHaveBeenCalledTimes(1);
  });
});
