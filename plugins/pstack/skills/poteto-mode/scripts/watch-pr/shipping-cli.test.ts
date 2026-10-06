import { expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { object } from "./landing.ts";

function fixture(
  body: (
    run: (...args: string[]) => {
      status: number | null;
      output: Record<string, unknown>;
    },
    file: string,
    dir: string
  ) => void
) {
  const dir = mkdtempSync(join(tmpdir(), "shipping-cli-"));
  const file = join(dir, "state.json");
  writeFileSync(
    file,
    JSON.stringify({
      id: "pr-id",
      state: "OPEN",
      headRefOid: "head",
      baseRefName: "main",
      baseRefOid: "base",
      autoMergeRequest: { enabledAt: "now" },
      mergeQueueEntry: { id: "queue" },
      mergeCommit: null,
    })
  );
  const gh = join(dir, "gh");
  writeFileSync(
    gh,
    `#!${process.execPath}
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
const state = JSON.parse(readFileSync(process.env.SHIPPING_STATE, 'utf8'));
const args = process.argv.slice(2);
const query = args.find(arg => arg.startsWith('query='));
let result;
if (query.includes('disablePullRequestAutoMerge')) {
  state.autoMergeRequest = null;
  result = { disablePullRequestAutoMerge: { clientMutationId: null } };
} else if (query.includes('dequeuePullRequest')) {
  state.mergeQueueEntry = null;
  result = { dequeuePullRequest: { clientMutationId: null } };
} else result = { repository: { pullRequest: state } };
appendFileSync(process.env.SHIPPING_STATE + '.calls', query + '\\n');
writeFileSync(process.env.SHIPPING_STATE, JSON.stringify(state));
console.log(JSON.stringify({ data: result }));
`
  );
  chmodSync(gh, 0o755);
  const entry = join(dir, "entry.ts");
  writeFileSync(
    entry,
    `import { main } from ${JSON.stringify(join(import.meta.dir, "shipping-cli.ts"))}; process.exitCode = await main(process.argv.slice(2));`
  );
  const run = (...args: string[]) => {
    const result = spawnSync(process.execPath, [entry, ...args], {
      encoding: "utf8",
      timeout: 3000,
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        SHIPPING_STATE: file,
      },
    });
    return {
      status: result.status,
      output: object(JSON.parse(result.stdout), "CLI result"),
    };
  };
  try {
    body(run, file, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

it("the CLI inspects, saves, cancels both mechanisms, and reads back in fresh processes", () =>
  fixture((run, file, dir) => {
    const inspected = run("inspect", "--repo", "owner/repo", "--pr", "1");
    expect(inspected.status).toBe(0);
    expect(object(inspected.output.record, "record").revision).toEqual({
      context: { owner: "owner", repo: "repo", number: 1 },
      headRefOid: "head",
      baseRefName: "main",
      baseRefOid: "base",
    });
    const saved = join(dir, "record.json");
    writeFileSync(saved, JSON.stringify(inspected.output));
    const cancelled = run("cancel-pending", "--record", saved);
    expect(cancelled.status).toBe(0);
    expect(cancelled.output).toMatchObject({
      kind: "cancelled",
      record: { pending: { autoMerge: false, queueEntryId: null } },
    });
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
      autoMergeRequest: null,
      mergeQueueEntry: null,
    });
  }));

it("the CLI refuses a changed base without cancelling anything", () =>
  fixture((run, file, dir) => {
    const inspected = run("inspect", "--repo", "owner/repo", "--pr", "1");
    const saved = join(dir, "record.json");
    writeFileSync(saved, JSON.stringify(inspected.output));
    const changed = {
      ...JSON.parse(readFileSync(file, "utf8")),
      baseRefOid: "advanced",
    };
    writeFileSync(file, JSON.stringify(changed));
    const result = run("cancel-pending", "--record", saved);
    expect(result.status).toBe(1);
    expect(result.output.kind).toBe("changed");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(changed);
  }));

it("the CLI treats a missing queue field as unavailable", () =>
  fixture((run, file) => {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    delete raw.mergeQueueEntry;
    writeFileSync(file, JSON.stringify(raw));
    const result = run("inspect", "--repo", "owner/repo", "--pr", "1");
    expect(result.status).toBe(1);
    expect(result.output.kind).toBe("unavailable");
  }));

const GITLAB_HOST = "gitlab.example.com";
const HEAD = "a".repeat(40);
const TIP = "d".repeat(40);

function gitlabFixture(
  body: (
    run: (...args: string[]) => {
      status: number | null;
      output: Record<string, unknown>;
    },
    state: string,
    calls: () => string[][],
    dir: string
  ) => void,
  options: { armed?: boolean; listed?: string } = {}
) {
  const dir = mkdtempSync(join(tmpdir(), "shipping-gitlab-cli-"));
  const state = join(dir, "state.json");
  writeFileSync(
    state,
    JSON.stringify({
      version: { version: "18.11.12", enterprise: false },
      tip: TIP,
      mr: {
        id: 71441,
        iid: 7,
        state: "opened",
        sha: HEAD,
        target_branch: "main",
        merge_when_pipeline_succeeds: options.armed ?? false,
      },
    })
  );
  const glab = join(dir, "glab");
  writeFileSync(
    glab,
    `#!${process.execPath}
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.SHIPPING_STATE + '.calls', JSON.stringify(args) + '\\n');
if (args[0] === 'auth') { console.log(process.env.GLAB_LISTED); process.exit(0); }
const state = JSON.parse(readFileSync(process.env.SHIPPING_STATE, 'utf8'));
const endpoint = args[args.length - 1];
let reply;
if (endpoint === 'version') reply = state.version;
else if (endpoint.endsWith('/cancel_merge_when_pipeline_succeeds')) {
  state.mr.merge_when_pipeline_succeeds = false;
  writeFileSync(process.env.SHIPPING_STATE, JSON.stringify(state));
  reply = { status: 'success' };
} else if (/\\/merge_requests\\/\\d+$/.test(endpoint)) reply = state.mr;
else if (endpoint.includes('/repository/branches/')) reply = { name: 'main', commit: { id: state.tip } };
else { console.error('glab: 404 Not found (HTTP 404)'); process.exit(1); }
console.log(JSON.stringify(reply));
`
  );
  chmodSync(glab, 0o755);
  const entry = join(dir, "entry.ts");
  writeFileSync(
    entry,
    `import { main } from ${JSON.stringify(join(import.meta.dir, "shipping-cli.ts"))}; process.exitCode = await main(process.argv.slice(2));`
  );
  const run = (...args: string[]) => {
    const result = spawnSync(process.execPath, [entry, ...args], {
      encoding: "utf8",
      timeout: 10000,
      env: {
        PATH: `${dir}:${dirname(process.execPath)}:/usr/bin:/bin`,
        SHIPPING_STATE: state,
        GLAB_LISTED: options.listed ?? GITLAB_HOST,
      },
    });
    return {
      status: result.status,
      output: object(JSON.parse(result.stdout), "CLI result"),
    };
  };
  const calls = () => {
    try {
      return readFileSync(`${state}.calls`, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
    } catch {
      return [];
    }
  };
  try {
    body(run, state, calls, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const gitlabArgs = [
  "--host",
  GITLAB_HOST,
  "--repo",
  "group/project",
  "--pr",
  "7",
];

it("the CLI inspects a GitLab merge request and prints the project in the record context", () =>
  gitlabFixture((run, _state, calls) => {
    const inspected = run("inspect", ...gitlabArgs);
    expect(inspected.status).toBe(0);
    expect(inspected.output).toEqual({
      kind: "inspected",
      record: {
        revision: {
          context: { host: GITLAB_HOST, path: "group/project", number: 7 },
          headRefOid: HEAD,
          baseRefName: "main",
          baseRefOid: TIP,
        },
        pullRequestId: "71441",
        state: "OPEN",
        pending: { autoMerge: false, queueEntryId: null },
        mergeCommitOid: null,
      },
    });
    const [guard, ...api] = calls();
    expect(guard.slice(0, 2)).toEqual(["auth", "status"]);
    expect(api).toHaveLength(3);
    expect(
      api.every(
        (argv) => argv.slice(0, 3).join(" ") === `api --hostname ${GITLAB_HOST}`
      )
    ).toBe(true);
  }));

it("the CLI sends nothing to a host that glab is not logged in to", () =>
  gitlabFixture(
    (run, _state, calls) => {
      const inspected = run("inspect", ...gitlabArgs);
      expect(inspected.status).toBe(1);
      expect(inspected.output.kind).toBe("unavailable");
      expect(inspected.output.detail).toContain(
        `glab auth login --hostname ${GITLAB_HOST}`
      );
      expect(calls().map((argv) => argv[0])).toEqual(["auth"]);
    },
    { listed: "gitlab.com" }
  ));

it("the CLI cancels what is pending from a saved GitLab record in a fresh process", () =>
  gitlabFixture(
    (run, state, calls, dir) => {
      const inspected = run("inspect", ...gitlabArgs);
      expect(inspected.output).toMatchObject({
        record: { pending: { autoMerge: true } },
      });
      const saved = join(dir, "record.json");
      writeFileSync(saved, JSON.stringify(inspected.output));
      const posts = () =>
        calls().filter((argv) => argv.includes("--method")).length;
      expect(posts()).toBe(0);
      const cancelled = run("cancel-pending", "--record", saved);
      expect(cancelled.status).toBe(0);
      expect(cancelled.output).toMatchObject({
        kind: "cancelled",
        record: {
          revision: { context: { host: GITLAB_HOST, number: 7 } },
          pending: { autoMerge: false, queueEntryId: null },
        },
      });
      expect(posts()).toBe(1);
      expect(
        JSON.parse(readFileSync(state, "utf8")).mr.merge_when_pipeline_succeeds
      ).toBe(false);
    },
    { armed: true }
  ));

it("the CLI takes the host of a saved record from glab's list, and sends nothing to another host", () =>
  gitlabFixture((run, _state, calls, dir) => {
    const inspected = run("inspect", ...gitlabArgs);
    const record = JSON.parse(JSON.stringify(inspected.output));
    record.record.revision.context.host = "other.example.com";
    const saved = join(dir, "record.json");
    writeFileSync(saved, JSON.stringify(record));
    const refused = run("cancel-pending", "--record", saved);
    expect(refused.status).toBe(1);
    expect(refused.output.kind).toBe("unavailable");
    expect(refused.output.detail).toContain("other.example.com");
    expect(
      calls().filter((argv) => argv.join(" ").includes("other.example.com"))
    ).toEqual([]);
  }));

it("the CLI rejects a host, project path, or number that is not one before it runs glab", () =>
  gitlabFixture((run, _state, calls) => {
    for (const args of [
      ["--host", "evil.example.com/x", "--repo", "group/project", "--pr", "7"],
      ["--host", "-evil.example.com", "--repo", "group/project", "--pr", "7"],
      ["--host", GITLAB_HOST, "--repo", "../x", "--pr", "7"],
      ["--host", GITLAB_HOST, "--repo", "onlyone", "--pr", "7"],
      ["--host", GITLAB_HOST, "--repo", "group/project", "--pr", "0"],
      ["--host", GITLAB_HOST, "--repo", "group/project", "--pr", "1e21"],
    ]) {
      const result = run("inspect", ...args);
      expect(result.status).toBe(1);
      expect(result.output.kind).toBe("unavailable");
    }
    expect(calls()).toEqual([]);
  }));

it("the CLI reads --host github.com as the GitHub path, with the old repo rule", () =>
  fixture((run) => {
    const plain = run("inspect", "--repo", "owner/repo", "--pr", "1");
    const named = run(
      "inspect",
      "--host",
      "GitHub.com",
      "--repo",
      "owner/repo",
      "--pr",
      "1"
    );
    expect(named).toEqual(plain);
    expect(named.status).toBe(0);
    const nested = run(
      "inspect",
      "--host",
      "github.com",
      "--repo",
      "owner/group/repo",
      "--pr",
      "1"
    );
    expect(nested.status).toBe(1);
    expect(nested.output.detail).toBe("--repo must be owner/repo");
  }));

it("the CLI keeps its GitHub usage errors, which name the --repo shape owner/repo", () =>
  fixture((_run, _file, dir) => {
    const result = spawnSync(
      process.execPath,
      [join(dir, "entry.ts"), "inspect", "--pr", "1"],
      { encoding: "utf8", timeout: 3000 }
    );
    expect(result.status).toBe(64);
    expect(result.stderr).toContain(
      "required option '--repo <owner/repo>' not specified"
    );
  }));
