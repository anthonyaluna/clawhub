/* @vitest-environment node */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertCodexWorkerExecutionAllowed,
  isCodexWorkerExecutionAllowed,
  LOCAL_CODEX_WORKER_OPT_IN,
  resolveCodexWorkerHome,
} from "../codex-worker-guard";
import {
  buildPrompt,
  buildCodexExecArgs,
  codexEnv,
  skillSpectorEnv,
  normalizeSkillSpectorAnalysis,
  resolveSkillSpectorScanInput,
  writeArtifactWorkspace,
  writeJobDiagnostic,
} from "./run-codex-scan-worker";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "clawhub-codex-worker-test-"));
  tempDirs.push(dir);
  return dir;
}

describe("run-codex-scan-worker diagnostics", () => {
  it("keeps provider and worker secrets out of the Codex process environment", () => {
    vi.stubEnv("OPENAI_API_KEY", "synthetic-provider-secret");
    vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-other-provider-secret");
    vi.stubEnv("SECURITY_SCAN_WORKER_TOKEN", "synthetic-worker-secret");
    vi.stubEnv("UNLISTED_CREDENTIAL", "synthetic-unlisted-secret");
    vi.stubEnv("CODEX_HOME", join(tmpdir(), "clawhub-synthetic-auth-home"));
    const env = codexEnv();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.SECURITY_SCAN_WORKER_TOKEN).toBeUndefined();
    expect(env.UNLISTED_CREDENTIAL).toBeUndefined();
    expect(env.CODEX_HOME).toBe(process.env.CODEX_HOME);
    expect(env.PATH).toBe(process.env.PATH);
  });

  it("denies off-workspace file reads without disabling the trusted CLI runtime", () => {
    const runtime = join(tmpdir(), "clawhub-codex-runtime");
    vi.stubEnv("CODEX_SECURITY_SCAN_RUNTIME_DIR", runtime);
    const args = buildCodexExecArgs("/tmp/scan-artifact");
    expect(args).not.toContain("--sandbox");
    expect(args).toContain('default_permissions="clawscan"');
    const filesystem = args.find((arg) => arg.startsWith("permissions.clawscan.filesystem="));
    expect(filesystem).toContain('":root"="deny"');
    expect(filesystem).toContain('":minimal"="read"');
    expect(filesystem).toContain(`${JSON.stringify(runtime)}="read"`);
    expect(filesystem).toContain('":workspace_roots"={ "."="read" }');
    expect(args).toContain("permissions.clawscan.network.enabled=false");
    expect(args).toContain("--ignore-user-config");
    expect(args).toContain("--ephemeral");
  });

  it("rejects missing or root-wide runtime permissions before starting a scan", () => {
    vi.stubEnv("CODEX_SECURITY_SCAN_RUNTIME_DIR", "");
    expect(() => buildCodexExecArgs("/tmp/scan-artifact")).toThrow("RUNTIME_DIR");
    vi.stubEnv("CODEX_SECURITY_SCAN_RUNTIME_DIR", parse(tmpdir()).root);
    expect(() => buildCodexExecArgs("/tmp/scan-artifact")).toThrow("dedicated");
  });

  it("preserves SkillSpector provider authentication without forwarding the worker token", () => {
    vi.stubEnv("OPENAI_API_KEY", "synthetic-provider-secret");
    vi.stubEnv("SECURITY_SCAN_WORKER_TOKEN", "synthetic-worker-secret");
    expect(skillSpectorEnv().OPENAI_API_KEY).toBe("synthetic-provider-secret");
    expect(skillSpectorEnv().SECURITY_SCAN_WORKER_TOKEN).toBeUndefined();
  });

  it("rejects runtime permissions that also expose the credential home or artifact", () => {
    const base = join(tmpdir(), "clawhub-overlapping-runtime");
    vi.stubEnv("CODEX_HOME", join(base, "auth"));
    vi.stubEnv("CODEX_SECURITY_SCAN_RUNTIME_DIR", base);
    expect(() => buildCodexExecArgs(join(tmpdir(), "artifact"))).toThrow("dedicated");
    vi.stubEnv("CODEX_SECURITY_SCAN_RUNTIME_DIR", join(base, "artifact", "runtime"));
    expect(() => buildCodexExecArgs(join(base, "artifact"))).toThrow("dedicated");
  });

  it("rejects a credential home inside the model-readable workspace", () => {
    const workspace = join(tmpdir(), "clawhub-readable-workspace");
    vi.stubEnv("CODEX_SECURITY_SCAN_RUNTIME_DIR", join(tmpdir(), "clawhub-separate-runtime"));
    vi.stubEnv("CODEX_HOME", join(workspace, ".codex"));
    expect(() => buildCodexExecArgs(workspace)).toThrow("credential home");
  });

  it.skipIf(process.platform !== "linux" || !process.env.CODEX_SECURITY_SCAN_TEST_CLI)(
    "enforces credential isolation with the pinned Linux CLI and retains stored authentication",
    async () => {
      const base = await tempDir();
      const workspace = join(base, "workspace");
      const authHome = join(base, "auth");
      await mkdir(workspace);
      await mkdir(authHome);
      await writeFile(join(workspace, "SKILL.md"), "harmless artifact control");
      vi.stubEnv("CODEX_HOME", authHome);
      vi.stubEnv("OPENAI_API_KEY", "synthetic-only-inherited-key");
      const cli = process.env.CODEX_SECURITY_SCAN_TEST_CLI!;
      expect(execFileSync(cli, ["--version"], { encoding: "utf8", timeout: 10_000 }).trim()).toBe(
        "codex-cli 0.153.4",
      );
      execFileSync(cli, ["login", "--with-api-key"], {
        env: codexEnv(),
        input: "synthetic-only",
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      await symlink(join(authHome, "auth.json"), join(workspace, "credential-alias"));
      const args = buildCodexExecArgs(workspace);
      const config = args.flatMap((arg, index) =>
        arg === "-c" ? args.slice(index, index + 2) : [],
      );
      const probe = [
        "import json,pathlib,sys",
        "def readable(path):",
        " try: return 'synthetic-only' in pathlib.Path(path).read_text()",
        " except (PermissionError,FileNotFoundError): return False",
        "print(json.dumps({'credential':readable(sys.argv[1]),'alias':readable('credential-alias'),'artifact':pathlib.Path('SKILL.md').read_text()=='harmless artifact control'}))",
      ].join("\n");
      const inspect = (profile: string, overrides: string[] = []) =>
        JSON.parse(
          execFileSync(
            cli,
            [
              ...overrides,
              "sandbox",
              "-P",
              profile,
              "-C",
              workspace,
              "--",
              "/usr/bin/python3",
              "-c",
              probe,
              join(authHome, "auth.json"),
            ],
            { env: codexEnv(), encoding: "utf8", timeout: 30_000 },
          ),
        );
      expect(inspect(":read-only")).toEqual({ credential: true, alias: true, artifact: true });
      expect(inspect("clawscan", config)).toEqual({
        credential: false,
        alias: false,
        artifact: true,
      });
      expect(
        execFileSync(cli, [...config, "login", "status"], {
          env: codexEnv(),
          encoding: "utf8",
          timeout: 10_000,
          stdio: ["ignore", "pipe", "pipe"],
        }),
      ).toBeDefined();
    },
    60_000,
  );

  it("blocks direct local Codex security worker runs without opt-in", () => {
    expect(isCodexWorkerExecutionAllowed({})).toBe(false);
    expect(() => assertCodexWorkerExecutionAllowed({})).toThrow(
      `Refusing to run local Codex workers without ${LOCAL_CODEX_WORKER_OPT_IN}=1`,
    );
  });

  it("does not treat a bare GITHUB_ACTIONS flag as CI authorization", () => {
    expect(isCodexWorkerExecutionAllowed({ GITHUB_ACTIONS: "true" })).toBe(false);
    expect(() => assertCodexWorkerExecutionAllowed({ GITHUB_ACTIONS: "true" })).toThrow(
      `Refusing to run local Codex workers without ${LOCAL_CODEX_WORKER_OPT_IN}=1`,
    );
  });

  it("allows direct Codex security worker runs in GitHub Actions", () => {
    const env = {
      CI: "true",
      GITHUB_ACTIONS: "true",
      GITHUB_REPOSITORY: "openclaw/clawhub",
      GITHUB_RUN_ID: "123",
    };

    expect(isCodexWorkerExecutionAllowed(env)).toBe(true);
    expect(() => assertCodexWorkerExecutionAllowed(env)).not.toThrow();
  });

  it("allows direct local Codex security worker runs with explicit opt-in", () => {
    expect(isCodexWorkerExecutionAllowed({ [LOCAL_CODEX_WORKER_OPT_IN]: "1" })).toBe(true);
    expect(() =>
      assertCodexWorkerExecutionAllowed({ [LOCAL_CODEX_WORKER_OPT_IN]: "1" }),
    ).not.toThrow();
  });

  it("uses an isolated local Codex home for opted-in local workers by default", () => {
    expect(
      resolveCodexWorkerHome(
        { [LOCAL_CODEX_WORKER_OPT_IN]: "1" },
        "/repo/.codex/runtime/codex-workers/security-scan",
      ),
    ).toBe("/repo/.codex/runtime/codex-workers/security-scan");
    expect(
      resolveCodexWorkerHome(
        { [LOCAL_CODEX_WORKER_OPT_IN]: "1", CODEX_HOME: "/tmp/custom-codex-home" },
        "/repo/.codex/runtime/codex-workers/security-scan",
      ),
    ).toBe("/tmp/custom-codex-home");
  });

  it("frames workspace inspection as discretionary Codex research", () => {
    const prompt = buildPrompt(
      {
        job: {
          _id: "job123",
          hasMaliciousSignal: false,
          leaseToken: "lease-secret",
          source: "publish",
          targetKind: "skillVersion",
          waitForVtUntil: 0,
        },
        target: {},
      },
      [],
    );

    expect(prompt).toContain("Do your own security research");
    expect(prompt).toContain("Inspect workspace files when needed");
    expect(prompt).toContain("SkillSpector findings are advisory research-preview evidence");
    expect(prompt).toContain("not validated ground truth");
    expect(prompt).toContain("artifact-backed evidence");
    expect(prompt).toContain("totality of evidence");
    expect(prompt).not.toContain("incomplete_artifact_inspection");
    expect(prompt).not.toContain("Return the required JSON object only after those reads complete");
  });

  it("does not expose incomplete artifact inspection as an output-schema field", async () => {
    const raw = await readFile("scripts/security/codex-scan-output.schema.json", "utf8");
    const schema = JSON.parse(raw) as {
      required?: string[];
      properties?: Record<string, unknown>;
    };

    expect(schema.required).not.toContain("incomplete_artifact_inspection");
    expect(schema.properties).not.toHaveProperty("incomplete_artifact_inspection");
  });

  it("passes SkillSpector findings to Codex without asking for OWASP finding output", () => {
    const prompt = buildPrompt(
      {
        job: {
          _id: "job123",
          hasMaliciousSignal: false,
          leaseToken: "lease-secret",
          source: "publish",
          targetKind: "skillVersion",
          waitForVtUntil: 0,
        },
        target: {
          version: {
            skillSpectorAnalysis: {
              status: "suspicious",
              score: 55,
              recommendation: "DO_NOT_INSTALL",
              issueCount: 1,
              checkedAt: 123,
              issues: [
                {
                  issueId: "SDI-1",
                  severity: "HIGH",
                  confidence: 0.98,
                  file: "SKILL.md",
                  startLine: 3,
                  endLine: 6,
                  explanation:
                    "The manifest advertises a generic benchmark while the skill body executes shell commands.",
                  remediation: "Make the manifest and skill body describe the same behavior.",
                },
              ],
            },
          },
        },
      },
      [],
    );

    expect(prompt).toContain("SkillSpector findings supplied to Codex");
    expect(prompt).toContain("SDI-1");
    expect(prompt).toContain("DO_NOT_INSTALL");
    expect(prompt).not.toContain("agentic_risk_findings");
    expect(prompt).not.toContain("OWASP");
  });

  it("normalizes real SkillSpector JSON risk assessment fields", () => {
    const analysis = normalizeSkillSpectorAnalysis(
      JSON.stringify({
        risk_assessment: {
          score: 55,
          severity: "HIGH",
          recommendation: "DO_NOT_INSTALL",
        },
        metadata: {
          skillspector_version: "2.0.0",
        },
        issues: [
          {
            id: "SDI-1",
            pattern: "Description-Behavior Mismatch",
            severity: "HIGH",
            confidence: 0.97,
            location: {
              file: "SKILL.md",
              start_line: 3,
              end_line: 4,
            },
            explanation: "The manifest description does not match the skill behavior.",
            remediation: "Make the manifest and skill body describe the same behavior.",
            code_snippet: "description: Harmless local demo",
          },
        ],
      }),
      123,
    );

    expect(analysis).toMatchObject({
      checkedAt: 123,
      issueCount: 1,
      recommendation: "DO_NOT_INSTALL",
      scannerVersion: "2.0.0",
      score: 55,
      severity: "HIGH",
      status: "suspicious",
    });
    expect(analysis.issues[0]).toMatchObject({
      issueId: "SDI-1",
      file: "SKILL.md",
      startLine: 3,
      endLine: 4,
      codeSnippet: "description: Harmless local demo",
    });
  });

  it("caps stored SkillSpector issues while preserving the full issue count", () => {
    const longSnippet = "sensitive artifact text ".repeat(200);
    const analysis = normalizeSkillSpectorAnalysis(
      JSON.stringify({
        issues: Array.from({ length: 30 }, (_, index) => ({
          id: `SDI-${index + 1}`,
          severity: "HIGH",
          confidence: 0.97,
          explanation: `Issue ${index + 1}: ${longSnippet}`,
          finding: longSnippet,
          code_snippet: longSnippet,
        })),
      }),
      123,
    );

    expect(analysis.issueCount).toBe(30);
    expect(analysis.issues).toHaveLength(25);
    expect(analysis.issues[0]?.codeSnippet).toContain("...[truncated ");
    expect(analysis.issues[0]?.codeSnippet?.length).toBeLessThan(longSnippet.length);
  });

  it("scans the extracted package root for ClawPack artifacts", async () => {
    const workspace = await tempDir();
    await mkdir(join(workspace, "artifact", "package"), { recursive: true });
    await writeFile(join(workspace, "artifact.tgz"), "packed artifact");
    await writeFile(join(workspace, "artifact", "package", "package.json"), "{}");
    await writeFile(join(workspace, "artifact", "package.json"), "{}");

    await expect(resolveSkillSpectorScanInput(workspace)).resolves.toBe("artifact/package");
  });

  it("scans the artifact root when there is no ClawPack extraction", async () => {
    const workspace = await tempDir();
    await mkdir(join(workspace, "artifact"), { recursive: true });
    await writeFile(join(workspace, "artifact", "SKILL.md"), "# Skill");

    await expect(resolveSkillSpectorScanInput(workspace)).resolves.toBe("artifact");
  });

  it.each(["../escape.md", "../artifact-sibling/escape.md"])(
    "rejects artifact paths outside the workspace: %s",
    async (path) => {
      const workspace = await tempDir();
      await expect(
        writeArtifactWorkspace(
          {
            job: {
              _id: "job123",
              hasMaliciousSignal: false,
              leaseToken: "lease-secret",
              source: "publish",
              targetKind: "skillVersion",
              waitForVtUntil: 0,
            },
            target: {
              files: [{ path, sha256: "abc123", size: 7, url: "data:text/plain,escape" }],
            },
          },
          workspace,
        ),
      ).rejects.toThrow(/Unsafe artifact path/);
      await expect(readFile(join(workspace, "escape.md"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        readFile(join(workspace, "artifact-sibling", "escape.md")),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("writes scanner metadata without lease tokens or signed file URLs", async () => {
    const workspace = await tempDir();

    await writeArtifactWorkspace(
      {
        job: {
          _id: "job123",
          hasMaliciousSignal: false,
          leaseToken: "lease-secret",
          source: "publish",
          targetKind: "skillVersion",
          waitForVtUntil: 0,
        },
        target: {
          files: [
            {
              path: "SKILL.md",
              sha256: "abc123",
              size: 42,
              url: "data:text/plain,%23%20Skill",
            },
          ],
          job: {
            leaseToken: "nested-lease-secret",
          },
        },
      },
      workspace,
    );

    const metadataText = await readFile(join(workspace, "metadata.json"), "utf8");
    expect(metadataText).not.toContain("lease-secret");
    expect(metadataText).not.toContain("nested-lease-secret");
    expect(metadataText).not.toContain("data:text/plain");

    const metadata = JSON.parse(metadataText);
    expect(metadata.job).toMatchObject({
      _id: "job123",
      source: "publish",
      targetKind: "skillVersion",
    });
    expect(metadata.target.files).toEqual([{ path: "SKILL.md", sha256: "abc123", size: 42 }]);
  });

  it("writes redacted Codex diagnostics without copying submitted artifact files or signed URLs", async () => {
    const diagnosticsRoot = await tempDir();
    const artifactWorkspace = await tempDir();
    await mkdir(join(artifactWorkspace, "artifact"), { recursive: true });

    await writeJobDiagnostic({
      codex: {
        args: ["exec", "--sandbox", "read-only"],
        exitCode: 0,
        rawResult:
          '{"verdict":"benign","scan_findings_in_context":[{"ruleId":"x","expected_for_purpose":true,"note":"quoted artifact payload should not persist"}]}',
        stderr: "workspace read failed https://signed.example.invalid/file?token=secret",
        stdout:
          '{"type":"error","message":"Codex CLI provider returned HTTP 429 for https://signed.example.invalid/file?token=secret with api_key=sk-short-secret"}\n{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I could not inspect the artifact because the provider returned a transient error."}}\n{"type":"tool_call","status":"failed","api_key":"sk-short-secret","output":"read https://signed.example.invalid/file?token=secret","content":["quoted array artifact payload should not persist"]}\n',
      },
      skillSpector: {
        args: ["scan", "artifact", "--format", "json"],
        exitCode: 0,
        rawResult:
          '{"issues":[{"id":"SDI-1","code_snippet":"quoted SkillSpector artifact payload should not persist","finding":"matched SkillSpector artifact payload should not persist","explanation":"safe to redact"}]}',
      },
      completedAt: 2000,
      diagnosticsRoot,
      error:
        "Codex result did not match ClawScan schema: quoted artifact payload should not persist https://signed.example.invalid/file?token=secret",
      job: {
        job: {
          _id: "job123",
          hasMaliciousSignal: false,
          leaseToken: "lease-secret",
          source: "publish",
          targetKind: "skillVersion",
          waitForVtUntil: 0,
        },
        target: {
          files: [
            {
              path: "SKILL.md",
              sha256: "abc123",
              size: 42,
              url: "https://signed.example.invalid/file?token=secret",
            },
          ],
        },
      },
      llmAnalysis: { confidence: "low", status: "clean", verdict: "benign" },
      skillSpectorAnalysis: {
        status: "suspicious",
        issueCount: 1,
        checkedAt: 123,
        issues: [
          {
            issueId: "SDI-1",
            severity: "HIGH",
            explanation: "safe to redact",
            finding: "matched SkillSpector artifact payload should not persist",
            codeSnippet: "quoted SkillSpector artifact payload should not persist",
          },
        ],
      },
      runId: "26127771775",
      startedAt: 1000,
      status: "failed",
    });

    const jobDir = join(diagnosticsRoot, "job123");
    const stdoutText = await readFile(join(jobDir, "codex.stdout.redacted.jsonl"), "utf8");
    expect(stdoutText).toContain('"tool_call"');
    expect(stdoutText).toContain("Codex CLI provider returned HTTP 429");
    expect(stdoutText).toContain(
      "I could not inspect the artifact because the provider returned a transient error.",
    );
    expect(stdoutText).not.toContain("token=secret");
    expect(stdoutText).not.toContain("signed.example.invalid");
    expect(stdoutText).not.toContain("sk-short-secret");
    expect(stdoutText).not.toContain("quoted array artifact payload");
    expect(stdoutText).toContain('"api_key":"[redacted-secret]"');
    expect(stdoutText).toContain('"content":"[redacted 1 item(s)]"');
    await expect(readFile(join(jobDir, "codex.stderr.redacted.log"), "utf8")).resolves.toContain(
      "workspace read failed",
    );
    const stderrText = await readFile(join(jobDir, "codex.stderr.redacted.log"), "utf8");
    expect(stderrText).not.toContain("token=secret");
    const resultText = await readFile(join(jobDir, "codex-result.redacted.json"), "utf8");
    expect(resultText).toContain('"verdict"');
    expect(resultText).toContain('"note": "[redacted');
    expect(resultText).not.toContain("quoted artifact payload");
    const skillSpectorResultText = await readFile(
      join(jobDir, "skillspector-result.redacted.json"),
      "utf8",
    );
    expect(skillSpectorResultText).toContain('"code_snippet": "[redacted');
    expect(skillSpectorResultText).toContain('"finding": "[redacted');
    expect(skillSpectorResultText).not.toContain("SkillSpector artifact payload");

    const diagnostic = JSON.parse(await readFile(join(jobDir, "diagnostic.json"), "utf8"));
    expect(diagnostic).toMatchObject({
      job: {
        id: "job123",
        source: "publish",
        targetKind: "skillVersion",
      },
      llmAnalysis: {
        confidence: "low",
        status: "clean",
        verdict: "benign",
      },
      runId: "26127771775",
      status: "failed",
    });
    expect(diagnostic.job.leaseToken).toBeUndefined();
    expect(diagnostic.error).toBe(
      "Codex result did not match ClawScan schema: [redacted result body]",
    );
    expect(diagnostic.target.files).toEqual([{ path: "SKILL.md", sha256: "abc123", size: 42 }]);

    const diagnosticText = await readFile(join(jobDir, "diagnostic.json"), "utf8");
    expect(diagnosticText).not.toContain("lease-secret");
    expect(diagnosticText).not.toContain("token=secret");
    expect(diagnosticText).not.toContain("quoted artifact payload");
    expect(diagnosticText).not.toContain("SkillSpector artifact payload");
    expect(await readdir(jobDir)).not.toContain("artifact");
  });
});
