// Invoked by the Node test runner under real Bun. All external boundaries are
// stubbed; stdout contains only this fixture's synthetic multipart request.
import assert from "node:assert/strict";
import { createHttpClient } from "../../src/http.ts";

const writes = [];
let curlArgs;
let cleanup = 0;
const tempDir = 'C:\\synthetic temp,semi;quote"\\upload';
const client = createHttpClient({
  runtime: "bun",
  configureDispatcher: false,
  env: {},
  tmpdirPath: "synthetic-temp",
  mkdtempImpl: async () => tempDir,
  mkdirImpl: async () => {
    throw new Error("display filenames must not select staging paths");
  },
  writeFileImpl: async (path, bytes) => {
    writes.push({ path, bytes });
  },
  rmImpl: async (path) => {
    assert.equal(path, tempDir);
    cleanup += 1;
  },
  spawnSyncImpl: (command, args) => {
    assert.equal(command, "curl");
    curlArgs = args;
    return { status: 0, stdout: '{"ok":true}\n200', stderr: "" };
  },
});
const form = new FormData();
for (const value of [
  "@synthetic-canary.txt",
  "<synthetic-canary.txt",
  "value;headers=@synthetic-canary.txt",
]) {
  form.append("tag", value);
}
for (const [index, name] of [
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
].entries()) {
  form.append(
    "files",
    new Blob([new Uint8Array([index, 0, 255])], { type: "application/octet-stream" }),
    name,
  );
}
assert.deepEqual(
  await client.apiRequestForm("https://registry.example", {
    method: "POST",
    path: "/upload",
    token: "synthetic-token",
    form,
    retryCount: 0,
  }),
  { ok: true },
);
assert.equal(writes.length, 1);
assert.equal(cleanup, 1);
for (const option of ["-F", "--form", "--form-string"]) assert.ok(!curlArgs.includes(option));
assert.equal(curlArgs[curlArgs.indexOf("--data-binary") + 1], `@${writes[0].path}`);
const headers = [];
for (let index = 0; index < curlArgs.length; index += 1) {
  if (curlArgs[index] !== "-H") continue;
  const line = curlArgs[index + 1];
  const colon = line.indexOf(":");
  headers.push([line.slice(0, colon), line.slice(colon + 1).trim()]);
}
console.log(
  JSON.stringify({
    bytes: Buffer.from(writes[0].bytes).toString("base64"),
    headers,
    bun: process.versions.bun,
  }),
);
