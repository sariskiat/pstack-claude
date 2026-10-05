import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForgeError } from "../forge/forge.ts";
import { type CliRuntime, main, selectReader } from "./cli.ts";
import { renderPretty } from "./render.ts";
import { WatchDeadline } from "./deadline.ts";
import { GhGitHubReader } from "./github.ts";
import { GlabReader } from "./gitlab.ts";
import {
  HOST,
  PROJECT,
  fixture,
  glabReader,
  server,
} from "./gitlab.test-helper.ts";

const REMOTE = `https://${HOST}/${PROJECT}.git`;
const deadline = () => new WatchDeadline(0, () => 0);

interface Sandbox {
  readonly root: string;
  readonly bin: string;
  checkout(remote: string | null): string;
}

async function inSandbox(
  bins: Record<string, string>,
  run: (sandbox: Sandbox) => Promise<void>
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "watch-forge-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  for (const [name, body] of Object.entries(bins)) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const saved = process.env.PATH;
  let count = 0;
  try {
    process.env.PATH = `${bin}:${saved}`;
    await run({
      root,
      bin,
      checkout(remote) {
        const dir = join(root, `checkout-${count++}`);
        mkdirSync(dir);
        execFileSync("git", ["init", "-q", dir]);
        if (remote !== null)
          execFileSync("git", ["-C", dir, "remote", "add", "origin", remote]);
        return dir;
      },
    });
  } finally {
    process.env.PATH = saved;
    rmSync(root, { recursive: true, force: true });
  }
}

const MARKER = 'touch "$(dirname "$0")/../glab-ran"';
const glabRan = (sandbox: Sandbox) =>
  existsSync(join(sandbox.root, "glab-ran"));
const none = { owner: null, repo: null };

async function failureOf(promise: Promise<unknown>): Promise<ForgeError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ForgeError) return error;
    throw error;
  }
  throw new Error("expected a ForgeError");
}

describe("selectReader keeps the gh reader for everything GitHub did before", () => {
  it("uses gh for explicit --owner and --repo without touching git or glab", async () => {
    await inSandbox({ glab: "exit 9" }, async (sandbox) => {
      const reader = await selectReader({ owner: "o", repo: "r" }, deadline(), {
        checkout: join(sandbox.root, "not-a-checkout"),
      });
      expect(reader).toBeInstanceOf(GhGitHubReader);
    });
  });

  it("uses gh for a github.com origin and never runs glab", async () => {
    await inSandbox({ glab: "exit 9" }, async (sandbox) => {
      const dir = sandbox.checkout("git@github.com:o/r.git");
      const reader = await selectReader(none, deadline(), { checkout: dir });
      expect(reader).toBeInstanceOf(GhGitHubReader);
    });
  });

  it("uses gh when there is no origin remote or the remote is not a hosted URL", async () => {
    await inSandbox({ glab: "exit 9" }, async (sandbox) => {
      for (const remote of [null, "/srv/git/local.git"])
        expect(
          await selectReader(none, deadline(), {
            checkout: sandbox.checkout(remote),
          })
        ).toBeInstanceOf(GhGitHubReader);
    });
  });

  it("uses gh for a github.com origin even when an origin CLI is on PATH", async () => {
    await inSandbox({ origin: "exit 0" }, async (sandbox) => {
      const dir = sandbox.checkout("https://github.com/o/r");
      expect(
        await selectReader(none, deadline(), { checkout: dir })
      ).toBeInstanceOf(GhGitHubReader);
    });
  });
});

describe("selectReader reads a GitLab checkout through glab", () => {
  it("builds a GlabReader for the project of an origin that glab lists", async () => {
    await inSandbox({ glab: `printf '${HOST}\\n  ok\\n'` }, async (sandbox) => {
      const dir = sandbox.checkout(REMOTE);
      const reader = await selectReader(none, deadline(), { checkout: dir });
      expect(reader).toBeInstanceOf(GlabReader);
      expect(await reader.originRepo()).toEqual({ host: HOST, path: PROJECT });
    });
  });

  it("keeps every nested group segment and reads an scp remote the same way", async () => {
    await inSandbox({ glab: `printf '${HOST}\\n'` }, async (sandbox) => {
      const dir = sandbox.checkout(`git@${HOST}:platform/tools/app.git`);
      const reader = await selectReader(none, deadline(), { checkout: dir });
      expect(await reader.originRepo()).toEqual({
        host: HOST,
        path: "platform/tools/app",
      });
    });
  });

  it("fails with unknown-host and names glab auth login when glab does not list the host", async () => {
    await inSandbox({ glab: "printf 'gitlab.com\\n'" }, async (sandbox) => {
      const dir = sandbox.checkout(REMOTE);
      const error = await failureOf(
        selectReader(none, deadline(), { checkout: dir })
      );
      expect(error.code).toBe("unknown-host");
      expect(error.message).toContain(`glab auth login --hostname ${HOST}`);
    });
  });

  it("fails with glab-timeout, not unknown-host, when glab hangs", async () => {
    await inSandbox({ glab: "sleep 5" }, async (sandbox) => {
      const dir = sandbox.checkout(REMOTE);
      const error = await failureOf(
        selectReader(none, deadline(), { checkout: dir, glabTimeoutMs: 300 })
      );
      expect(error.code).toBe("glab-timeout");
      expect(error.message).toContain("did not answer");
      expect(error.message).toContain("VPN");
    });
  });

  it("refuses an origin forge it cannot read, without running glab", async () => {
    await inSandbox({ origin: "exit 0", glab: MARKER }, async (sandbox) => {
      const dir = sandbox.checkout(REMOTE);
      const error = await failureOf(
        selectReader(none, deadline(), { checkout: dir })
      );
      expect(error.code).toBe("unsupported-forge");
      expect(error.message).toContain(HOST);
      expect(glabRan(sandbox)).toBe(false);
    });
  });
});

function runtimeFor(
  reader: CliRuntime["reader"],
  sleeps: number[] | null = null
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const runtime: CliRuntime = {
    reader,
    deadline: new WatchDeadline(0, () => 0),
    clock: {
      now: () => 0,
      observedAt: () => "2026-07-26T00:00:00.000Z",
      async sleep(seconds) {
        if (sleeps === null) throw new Error("test unexpectedly slept");
        sleeps.push(seconds);
      },
    },
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
  };
  return { runtime, stdout, stderr };
}

describe("watch-pr on a GitLab checkout", () => {
  it("exits 7 with a glab-timeout verdict when glab does not answer", async () => {
    await inSandbox({ glab: "sleep 5" }, async (sandbox) => {
      const harness = runtimeFor({
        checkout: sandbox.checkout(REMOTE),
        glabTimeoutMs: 300,
      });
      expect(await main(["--pr", "1"], harness.runtime)).toBe(7);
      const verdict = JSON.parse(harness.stdout.join(""));
      expect(verdict).toMatchObject({
        kind: "BLOCKER",
        exitCode: 7,
        blocker: {
          kind: "status-query",
          failure: {
            kind: "forge-unavailable",
            code: "glab-timeout",
            retryable: false,
          },
        },
      });
      expect(verdict.blocker.failure.detail).toContain(
        "glab did not answer within 0.3 s"
      );
      expect(verdict.blocker.failure.detail).toContain("VPN");
      expect(JSON.stringify(verdict)).not.toContain("unknown-host");
      expect(harness.stderr).toEqual([]);
    });
  });

  it("exits 7 and names glab auth login when glab is logged out", async () => {
    await inSandbox({ glab: "printf 'gitlab.com\\n'" }, async (sandbox) => {
      const harness = runtimeFor({ checkout: sandbox.checkout(REMOTE) });
      expect(await main(["--pr", "1", "--pretty"], harness.runtime)).toBe(7);
      const text = harness.stdout.join("");
      expect(text).toContain("BLOCKER: status-query");
      expect(text).toContain(`glab auth login --hostname ${HOST}`);
      expect(text).toContain(
        "action=fix the problem named in detail, then rearm"
      );
      expect(text).not.toContain("GitHub authentication");
    });
  });

  it("reads a green merge request as READY through the unchanged policy", async () => {
    const { reader } = glabReader({
      mr: fixture("mr-green.json"),
      approvals: fixture("approvals-green.json"),
      jobs: fixture("jobs-green.json"),
    });
    const harness = runtimeFor(reader);
    expect(await main(["--pr", "1"], harness.runtime)).toBe(0);
    expect(JSON.parse(harness.stdout.join(""))).toMatchObject({
      kind: "READY",
      exitCode: 0,
      scope: {
        pr: {
          kind: "ready-pr",
          context: { host: HOST, path: PROJECT, number: 1 },
        },
      },
    });
  });

  it("links the status table to the merge request page", async () => {
    const { reader } = glabReader({
      mr: fixture("mr-green.json"),
      approvals: fixture("approvals-green.json"),
      jobs: fixture("jobs-green.json"),
    });
    const harness = runtimeFor(reader);
    expect(
      await main(["--pr", "1", "--status-only", "--pretty"], harness.runtime)
    ).toBe(0);
    expect(harness.stdout.join("")).toContain(
      `[#1](https://${HOST}/${PROJECT}/-/merge_requests/1)`
    );
  });

  it("refuses a --pr that is not a safe integer before any glab call", async () => {
    const { reader, calls } = glabReader({ mr: fixture("mr-green.json") });
    const harness = runtimeFor(reader);
    expect(await main(["--pr", "1e21"], harness.runtime)).toBe(64);
    expect(calls).toEqual([]);
  });

  it("ends with exit 7, not a crash, when the current branch's merge request has an iid that is not a safe integer", async () => {
    await inSandbox({}, async (sandbox) => {
      const { exec } = server({
        mrList: [{ iid: "7", source_project_id: 42, target_project_id: 42 }],
      });
      const reader = new GlabReader({ host: HOST, path: PROJECT }, deadline(), {
        exec,
        cwd: sandbox.checkout(REMOTE),
      });
      const harness = runtimeFor(reader);
      expect(await main([], harness.runtime)).toBe(7);
      expect(JSON.parse(harness.stdout.join(""))).toMatchObject({
        blocker: {
          kind: "status-query",
          failure: {
            kind: "missing-key",
            detail: 'invalid merge request.iid: "7"',
          },
        },
      });
    });
  });

  it("refuses --owner and --repo on a GitLab reader", async () => {
    const { reader } = glabReader({ mr: fixture("mr-green.json") });
    const harness = runtimeFor(reader);
    expect(await main(["--owner", "o", "--pr", "1"], harness.runtime)).toBe(7);
    expect(harness.stdout.join("")).toContain(
      "--owner and --repo name a GitHub repository"
    );
  });
});

describe("GitLab output names no GitHub, and GitHub output keeps its words", () => {
  const stamp = {
    schemaVersion: 1,
    sequence: 1,
    observedAt: "fixture",
    mode: "single",
  } as const;
  const failure = {
    kind: "command-exit",
    retryable: true,
    code: 1,
    detail: "boom",
  } as const;
  const retry = {
    ...stamp,
    kind: "RETRY",
    terminal: false,
    failure,
    consecutiveFailures: 1,
    retryInSeconds: 60,
  } as const;
  const timeout = {
    ...stamp,
    kind: "TIMEOUT",
    terminal: true,
    exitCode: 5,
    reason: { kind: "status-unavailable", failure },
  } as const;
  const statusQuery = {
    ...stamp,
    kind: "BLOCKER",
    terminal: true,
    exitCode: 7,
    blocker: { kind: "status-query", failures: 1, failure },
  } as const;

  it("keeps the GitHub RETRY, TIMEOUT, and status-query words byte for byte", () => {
    expect(renderPretty(retry, "github")).toBe(
      "RETRY: GitHub status query failed; retrying in 60s\ndetail=boom\n"
    );
    expect(renderPretty(timeout, "github")).toBe(
      "TIMEOUT: GitHub status remained unavailable\n"
    );
    expect(renderPretty(statusQuery, "github")).toBe(
      "BLOCKER: status-query\nfailures=1\ndetail=boom\naction=verify current PR context, GitHub authentication, and API availability, then rearm\n"
    );
  });

  it("says no GitHub in a GitLab RETRY, TIMEOUT, or status-query line", () => {
    for (const verdict of [retry, timeout, statusQuery])
      expect(renderPretty(verdict, "gitlab")).not.toContain("GitHub");
    expect(renderPretty(timeout, "gitlab")).toBe(
      "TIMEOUT: status remained unavailable\n"
    );
  });

  it("prints detailed_merge_status for a blocked merge request and no branch protection advice", async () => {
    const { reader } = glabReader({
      mr: fixture("mr-need-rebase.json"),
      approvals: fixture("approvals-green.json"),
      jobs: fixture("jobs-green.json"),
    });
    const pretty = runtimeFor(reader);
    expect(await main(["--pr", "1", "--pretty"], pretty.runtime)).toBe(6);
    const text = pretty.stdout.join("");
    expect(text).toContain(
      "BLOCKER: merge-blocked\npr=1\ndetailed_merge_status=need_rebase\n"
    );
    expect(text).not.toContain("branch protection");
    expect(text).not.toContain("GitHub");
    const json = runtimeFor(
      glabReader({
        mr: fixture("mr-need-rebase.json"),
        approvals: fixture("approvals-green.json"),
        jobs: fixture("jobs-green.json"),
      }).reader
    );
    expect(await main(["--pr", "1"], json.runtime)).toBe(6);
    expect(JSON.parse(json.stdout.join("")).blocker).toMatchObject({
      kind: "merge-gate",
      reason: "merge-blocked",
      detailedMergeStatus: "need_rebase",
    });
  });

  it("retries a merge request GitLab is still preparing with a RETRY line that names no GitHub", async () => {
    const { reader } = glabReader({
      mr: fixture("mr-preparing.json"),
      approvals: fixture("approvals-green.json"),
    });
    const sleeps: number[] = [];
    const harness = runtimeFor(reader, sleeps);
    expect(
      await main(
        ["--pr", "12", "--pretty", "--max-query-errors", "2"],
        harness.runtime
      )
    ).toBe(7);
    const text = harness.stdout.join("");
    expect(text).toStartWith("RETRY: status query failed; retrying in 60s\n");
    expect(text).toContain(
      "action=verify the current merge request, GitLab authentication, and API availability, then rearm"
    );
    expect(text).not.toContain("GitHub");
    expect(sleeps).toEqual([60]);
  });
});
