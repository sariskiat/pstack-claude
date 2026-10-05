import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/** The gh reader runs git and gh in the process directory, which is the checkout outside tests. */
async function mainIn(
  dir: string,
  argv: readonly string[],
  runtime: CliRuntime
): Promise<number> {
  const saved = process.cwd();
  process.chdir(dir);
  try {
    return await main(argv, runtime);
  } finally {
    process.chdir(saved);
  }
}

const MARKER = 'touch "$(dirname "$0")/../glab-ran"';
const glabRan = (sandbox: Sandbox) =>
  existsSync(join(sandbox.root, "glab-ran"));
const none = { owner: null, repo: null };

const NO_GITHUB_REMOTE =
  "none of the git remotes configured for this repository point to a known GitHub host. To tell gh about a new GitHub host, please use `gh auth login`";
const GH_FINDS_NO_REMOTE = `echo '${NO_GITHUB_REMOTE}' >&2; exit 1`;

describe("selectReader keeps the gh reader for everything GitHub did before", () => {
  it("uses gh for explicit --owner and --repo without touching git or glab", async () => {
    await inSandbox({ glab: "exit 9" }, async (sandbox) => {
      const choice = await selectReader({ owner: "o", repo: "r" }, deadline(), {
        checkout: join(sandbox.root, "not-a-checkout"),
      });
      expect(choice.reader).toBeInstanceOf(GhGitHubReader);
      expect(choice.ifGhFails).toBeNull();
    });
  });

  it("uses gh for a github.com origin and never runs glab", async () => {
    await inSandbox({ glab: MARKER }, async (sandbox) => {
      const dir = sandbox.checkout("git@github.com:o/r.git");
      const choice = await selectReader(none, deadline(), { checkout: dir });
      expect(choice.reader).toBeInstanceOf(GhGitHubReader);
      expect(glabRan(sandbox)).toBe(false);
    });
  });

  it("uses gh when there is no origin remote or the remote is not a hosted URL", async () => {
    await inSandbox({ glab: "exit 9" }, async (sandbox) => {
      for (const remote of [null, "/srv/git/local.git"])
        expect(
          (
            await selectReader(none, deadline(), {
              checkout: sandbox.checkout(remote),
            })
          ).reader
        ).toBeInstanceOf(GhGitHubReader);
    });
  });

  it("uses gh for a github.com origin even when an origin CLI is on PATH", async () => {
    await inSandbox({ origin: "exit 0" }, async (sandbox) => {
      const dir = sandbox.checkout("https://github.com/o/r");
      expect(
        (await selectReader(none, deadline(), { checkout: dir })).reader
      ).toBeInstanceOf(GhGitHubReader);
    });
  });

  it("uses gh for a host glab does not list, keeping unknown-host, glab-timeout, or unsupported-forge for when gh fails too", async () => {
    const cases = [
      [{ glab: "printf 'gitlab.com\\n'" }, undefined, "unknown-host"],
      [{ glab: "sleep 5" }, 300, "glab-timeout"],
      [{ origin: "exit 0", glab: MARKER }, undefined, "unsupported-forge"],
    ] as const;
    for (const [bins, glabTimeoutMs, code] of cases)
      await inSandbox(bins, async (sandbox) => {
        const choice = await selectReader(none, deadline(), {
          checkout: sandbox.checkout(REMOTE),
          glabTimeoutMs,
        });
        expect(choice.reader).toBeInstanceOf(GhGitHubReader);
        expect(choice.ifGhFails?.code).toBe(code);
        expect(choice.ifGhFails?.message).toContain(HOST);
        expect(glabRan(sandbox)).toBe(false);
      });
  });
});

describe("selectReader reads a GitLab checkout through glab", () => {
  it("builds a GlabReader for the project of an origin that glab lists", async () => {
    await inSandbox({ glab: `printf '${HOST}\\n  ok\\n'` }, async (sandbox) => {
      const dir = sandbox.checkout(REMOTE);
      const { reader } = await selectReader(none, deadline(), {
        checkout: dir,
      });
      expect(reader).toBeInstanceOf(GlabReader);
      expect(await reader.originRepo()).toEqual({ host: HOST, path: PROJECT });
    });
  });

  it("keeps every nested group segment and reads an scp remote the same way", async () => {
    await inSandbox({ glab: `printf '${HOST}\\n'` }, async (sandbox) => {
      const dir = sandbox.checkout(`git@${HOST}:platform/tools/app.git`);
      const { reader } = await selectReader(none, deadline(), {
        checkout: dir,
      });
      expect(await reader.originRepo()).toEqual({
        host: HOST,
        path: "platform/tools/app",
      });
    });
  });
});

describe("a GitHub origin that is not literally github.com reaches gh, as before GitLab support", () => {
  const SHA = "a".repeat(40);
  const closedPr = JSON.stringify({
    mergeable: "UNKNOWN",
    mergeStateStatus: "UNKNOWN",
    reviewDecision: "",
    headRefOid: SHA,
    baseRefOid: SHA,
    headRefName: "topic",
    baseRefName: "main",
    state: "CLOSED",
    mergedAt: null,
    isDraft: false,
  });
  const gh = `echo "$*" >> "$(dirname "$0")/../gh-args"
case "$1 $2 $3 $4" in
  "pr view 1 --json") echo '{"number":1,"url":"https://github.com/o/r/pull/1"}' ;;
  "pr view 1 --repo") echo '${closedPr}' ;;
  *) echo "fake gh: $*" >&2; exit 1 ;;
esac`;

  for (const remote of [
    "git@github.com-work:o/r.git",
    "ssh://git@ssh.github.com:443/o/r.git",
  ])
    it(`reads ${remote} through gh and reports the pull request's own verdict`, async () => {
      await inSandbox({ glab: `printf '${HOST}\\n'`, gh }, async (sandbox) => {
        const dir = sandbox.checkout(remote);
        const harness = runtimeFor({ checkout: dir });
        expect(await mainIn(dir, ["--pr", "1"], harness.runtime)).toBe(6);
        expect(JSON.parse(harness.stdout.join(""))).toMatchObject({
          blocker: {
            kind: "merge-gate",
            reason: "closed-without-merge",
            pr: { owner: "o", repo: "r", number: 1 },
          },
        });
        expect(readFileSync(join(sandbox.root, "gh-args"), "utf8")).toContain(
          "pr view 1 --repo o/r --json"
        );
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
  it("exits 7 with a glab-timeout verdict when glab does not answer and gh finds no GitHub remote", async () => {
    await inSandbox(
      { glab: "sleep 5", gh: GH_FINDS_NO_REMOTE },
      async (sandbox) => {
        const dir = sandbox.checkout(REMOTE);
        const harness = runtimeFor({ checkout: dir, glabTimeoutMs: 300 });
        expect(await mainIn(dir, ["--pr", "1"], harness.runtime)).toBe(7);
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
      }
    );
  });

  it("exits 7 and names glab auth login when glab is logged out and gh finds no GitHub remote", async () => {
    await inSandbox(
      { glab: "printf 'gitlab.com\\n'", gh: GH_FINDS_NO_REMOTE },
      async (sandbox) => {
        const dir = sandbox.checkout(REMOTE);
        const harness = runtimeFor({ checkout: dir });
        expect(
          await mainIn(dir, ["--pr", "1", "--pretty"], harness.runtime)
        ).toBe(7);
        const text = harness.stdout.join("");
        expect(text).toContain("BLOCKER: status-query");
        expect(text).toContain(`glab auth login --hostname ${HOST}`);
        expect(text).toContain(
          `gh could not read the repository either: ${NO_GITHUB_REMOTE}`
        );
        expect(text).toContain(
          "action=fix the problem named in detail, then rearm"
        );
        expect(text).not.toContain("GitHub authentication");
      }
    );
  });

  it("names glab auth login and gh's own reason when gh is logged out or not installed", async () => {
    const loggedOut =
      "To get started with GitHub CLI, please run:  gh auth login";
    await inSandbox(
      { glab: "printf 'gitlab.com\\n'", gh: `echo '${loggedOut}' >&2; exit 4` },
      async (sandbox) => {
        const dir = sandbox.checkout(REMOTE);
        const harness = runtimeFor({ checkout: dir });
        expect(await mainIn(dir, ["--pr", "1"], harness.runtime)).toBe(7);
        const { failure } = JSON.parse(harness.stdout.join("")).blocker;
        expect(failure.code).toBe("unknown-host");
        expect(failure.detail).toContain(`glab auth login --hostname ${HOST}`);
        expect(failure.detail).toContain(loggedOut);
      }
    );
    await inSandbox({ glab: "printf 'gitlab.com\\n'" }, async (sandbox) => {
      process.env.PATH = `${sandbox.bin}:/usr/bin:/bin`;
      const dir = sandbox.checkout(REMOTE);
      const harness = runtimeFor({ checkout: dir });
      expect(await mainIn(dir, ["--pr", "1"], harness.runtime)).toBe(7);
      const { failure } = JSON.parse(harness.stdout.join("")).blocker;
      expect(failure.code).toBe("unknown-host");
      expect(failure.detail).toContain(
        "gh could not read the repository either: gh is not installed"
      );
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
