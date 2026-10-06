import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StackRow } from "./stack.ts";
import {
  NotFoundError,
  UserError,
  openStore,
  parseVerdict,
  type OpenStoreOptions,
  type Store,
} from "./store.ts";

setDefaultTimeout(30_000);

const SCRIPT = join(import.meta.dir, "orch.ts");
const directories: string[] = [];
const handles: Store[] = [];

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function makeDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "orch-test-"));
  directories.push(directory);
  return directory;
}

function useStore(
  directory: string,
  options?: OpenStoreOptions
): Store {
  const store = openStore(directory, options);
  handles.push(store);
  return store;
}

async function initializedStore(): Promise<{
  readonly directory: string;
  readonly store: Store;
}> {
  const directory = await makeDirectory();
  const store = useStore(directory, { gt: fakeGtPath(directory) });
  await store.init();
  return { directory, store };
}

function git({
  args,
  repo,
}: {
  args: readonly string[];
  repo: string;
}): string {
  const result = Bun.spawnSync(["git", "-C", repo, ...args]);
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr.toString()}`
    );
  }
  return result.stdout.toString().trim();
}

async function makeGitStack(directory: string): Promise<{
  readonly repo: string;
  readonly mergedSha: string;
  readonly closedSha: string;
  readonly openSha: string;
}> {
  const repo = join(directory, "repo");
  await mkdir(repo);
  git({ repo, args: ["init", "--initial-branch=main"] });
  git({ repo, args: ["config", "user.name", "Orch Test"] });
  git({ repo, args: ["config", "user.email", "orch@example.com"] });
  await writeFile(join(repo, "main.txt"), "main\n");
  git({ repo, args: ["add", "."] });
  git({ repo, args: ["commit", "-m", "main"] });

  const branches = ["stack/merged", "stack/closed", "stack/open"];
  for (const [index, branch] of branches.entries()) {
    git({ repo, args: ["checkout", "-b", branch] });
    await writeFile(join(repo, `stack-${index}.txt`), `${branch}\n`);
    git({ repo, args: ["add", "."] });
    git({ repo, args: ["commit", "-m", branch] });
  }

  return {
    repo,
    mergedSha: git({ repo, args: ["rev-parse", "stack/merged"] }),
    closedSha: git({ repo, args: ["rev-parse", "stack/closed"] }),
    openSha: git({ repo, args: ["rev-parse", "stack/open"] }),
  };
}

function fakeGtPath(directory: string): string {
  return join(directory, "bin", "gt");
}

async function withFakeGt<T>({
  directory,
  operation,
  output,
}: {
  directory: string;
  operation: (outputPath: string) => Promise<T>;
  output: string;
}): Promise<T> {
  const bin = join(directory, "bin");
  const outputPath = join(directory, "gt-output.txt");
  await mkdir(bin);
  await writeFile(outputPath, output);
  const gt = fakeGtPath(directory);
  await writeFile(
    gt,
    `#!/usr/bin/env bash
set -euo pipefail
if [ "$(pwd -P)" != "${realpathSync(join(directory, "repo"))}" ]; then
  printf 'gt ran outside the fixture repo: %s\\n' "$(pwd -P)" >&2
  exit 2
fi
case "$*" in
  "--no-interactive log short --stack --reverse")
    cat "${outputPath}"
    ;;
  "--no-interactive info stack/merged")
    printf 'stack/merged\\nPR #10 (Merged) merged change\\n'
    ;;
  "--no-interactive info stack/closed")
    printf 'stack/closed\\nPR #13 (Closed) closed change\\n'
    ;;
  "--no-interactive info stack/open")
    printf 'stack/open\\nPR #11 (Needs approvals) open change\\n'
    ;;
  *)
    printf 'unexpected gt arguments: %s\\n' "$*" >&2
    exit 2
    ;;
esac
`
  );
  await chmod(gt, 0o755);
  return operation(outputPath);
}

function runCli(
  args: readonly string[],
  env?: Readonly<Record<string, string | undefined>>
): RunResult {
  const result = Bun.spawnSync([process.execPath, SCRIPT, ...args], { env });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

const plain = (row: StackRow): Record<string, string> => ({
  branch: String(row.branch),
  parent: String(row.parent),
  parentTip: String(row.parentTip),
});

async function asActor<T>(
  directory: string,
  actor: string | undefined,
  run: (store: Store) => Promise<T>
): Promise<T> {
  const store = openStore(directory, { actor });
  try {
    return await run(store);
  } finally {
    await store.close();
  }
}

async function stackFixture(): Promise<{
  readonly directory: string;
  readonly repo: string;
  readonly mainSha: string;
  readonly mergedSha: string;
  readonly closedSha: string;
  readonly openSha: string;
}> {
  const directory = await makeDirectory();
  await asActor(directory, undefined, async (store) => {
    await store.init();
    await store.standing.add({ line: "stacker: stacker-1" });
  });
  const stack = await makeGitStack(directory);
  return {
    directory,
    ...stack,
    mainSha: git({ repo: stack.repo, args: ["rev-parse", "main"] }),
  };
}

afterEach(async () => {
  for (const store of handles.splice(0).reverse()) {
    await store.close();
  }
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("Store", () => {
  it("initializes an idempotent plain-file store and releases its lock", async () => {
    const directory = await makeDirectory();
    const store = useStore(directory);

    expect(await store.init()).toEqual({ store: directory });
    const firstUnits = await readFile(join(directory, "units.tsv"), "utf8");
    const firstLedger = await readFile(
      join(directory, "ledger.tsv"),
      "utf8"
    );

    expect(await store.init()).toEqual({ store: directory });
    expect(await readFile(join(directory, "units.tsv"), "utf8")).toBe(
      firstUnits
    );
    expect(await readFile(join(directory, "ledger.tsv"), "utf8")).toBe(
      firstLedger
    );
    expect((await readdir(directory)).sort()).toEqual([
      ".orch.lock",
      "frontier.json",
      "gates.md",
      "inbox",
      "ledger.tsv",
      "preferences.md",
      "stack.tsv",
      "units.tsv",
    ]);

    await store.close();
    expect(await readdir(directory)).not.toContain(".orch.lock");
  });

  it("composes unit add, set, get, list, and counts", async () => {
    const { store } = await initializedStore();

    expect(
      await store.units.add({
        id: "u1",
        track: "build",
        brief: "briefs/u1.md",
      })
    ).toMatchObject({ id: "u1", state: "pending" });
    expect(
      await store.units.add({ id: "=SUM(A1)", track: "+build" })
    ).toMatchObject({ id: "'=SUM(A1)", track: "'+build" });

    const updated = await store.units.set({
      id: "u1",
      state: "done",
      branch: "poteto/u1",
      pr: 184530,
      sha: "abc123",
    });
    expect(updated).toEqual({
      id: "u1",
      track: "build",
      state: "done",
      branch: "poteto/u1",
      pr: "184530",
      sha: "abc123",
      brief: "briefs/u1.md",
    });
    expect(await store.units.get("u1")).toEqual(updated);
    expect(
      await store.units.list({ state: "done", track: "build" })
    ).toEqual([updated]);
    expect(await store.units.counts()).toEqual({ done: 1, pending: 1 });
    await expect(
      store.units.add({ id: "u1", track: "build" })
    ).rejects.toThrow("unit u1 already exists");
    await expect(
      store.units.set({ id: "missing", state: "done" })
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("records, replaces, checks, and summarizes typed ledger verdicts", async () => {
    const { store } = await initializedStore();

    try {
      await store.ledger.check({ pr: 184530, sha: "abc123" });
      throw new Error("expected ledger check to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(NotFoundError);
      if (error instanceof NotFoundError) {
        expect(error.output).toEqual({
          compact: "NOT-VERIFIED",
          json: {
            pr: "184530",
            sha: "abc123",
            verdict: "NOT-VERIFIED",
          },
        });
      }
    }
    expect(() => parseVerdict("looks-good")).toThrow("verdict must be");

    const recorded = await store.ledger.record({
      pr: 184530,
      sha: "abc123",
      verdict: "unit-test-verified",
      evidence: "reports/verify.md",
      verifier: "sol",
    });
    expect(await store.ledger.check({ pr: 184530, sha: "abc123" })).toEqual(
      recorded
    );
    expect(await store.ledger.summary()).toEqual({
      "unit-test-verified": 1,
    });

    await store.ledger.record({
      pr: 184530,
      sha: "abc123",
      verdict: "live-ui-verified",
      evidence: "reports/live.md",
    });
    expect(await store.ledger.summary()).toEqual({
      "live-ui-verified": 1,
    });
  });

  it("pushes, peeks, and atomically drains inbox pointers", async () => {
    const { directory, store } = await initializedStore();

    const first = await store.inbox.push({
      agent: "worker-1",
      unit: "u1",
      status: "done",
      report: "reports/u1.md",
    });
    expect(first.pointer).toMatchObject({ unit: "u1", status: "done" });
    expect(first.filename).toEndWith(".tsv");
    await store.inbox.push({
      agent: "worker-2",
      unit: "u2",
      status: "failed",
    });

    expect(await store.inbox.count()).toBe(2);
    expect(await store.inbox.peek()).toHaveLength(2);
    expect(await store.inbox.count()).toBe(2);
    expect(await store.inbox.drain()).toHaveLength(2);
    expect(await store.inbox.count()).toBe(0);
    expect(await readdir(join(directory, "inbox"))).toEqual([]);
    expect(
      (await readdir(directory)).filter((name) =>
        name.startsWith(".inbox-drain-")
      )
    ).toEqual([]);
  });

  it("replaces a stale lock whose holder pid is dead", async () => {
    const { directory } = await initializedStore();
    const exited = Bun.spawn(["true"]);
    await exited.exited;
    await writeFile(join(directory, ".orch.lock"), `${exited.pid}\n`);

    const stale: string[] = [];
    const recovered = useStore(directory, {
      onStaleLock: (holder) => stale.push(holder),
    });
    expect(
      await recovered.units.add({ id: "u1", track: "build" })
    ).toMatchObject({ id: "u1" });
    expect(stale).toEqual([String(exited.pid)]);
    await recovered.close();
    expect(await readdir(directory)).not.toContain(".orch.lock");
  });

  it("blocks a writer and steals the pid lock only with force", async () => {
    const { directory, store } = await initializedStore();
    await store.close();
    await writeFile(join(directory, ".orch.lock"), `${process.pid}\n`);

    const blocked = useStore(directory);
    await expect(
      blocked.units.add({ id: "u1", track: "build" })
    ).rejects.toThrow(`store lock held by pid ${process.pid}`);

    const stolen: string[] = [];
    const forced = useStore(directory, {
      force: true,
      onLockStolen: (holder) => stolen.push(holder),
    });
    expect(
      await forced.units.add({ id: "u1", track: "build" })
    ).toMatchObject({ id: "u1" });
    expect(stolen).toEqual([String(process.pid)]);
    await forced.close();
    expect(await readdir(directory)).not.toContain(".orch.lock");
  });

  it("parks gates, stores standing orders, and renders status", async () => {
    const { directory, store } = await initializedStore();
    await store.units.add({ id: "u1", track: "build" });
    expect(
      await store.gates.park({
        id: "release",
        question: "Ship now?",
        options: "ship,wait",
        defaultAnswer: "wait",
      })
    ).toMatchObject({ kind: "open", id: "release" });
    expect(
      await store.standing.add({ line: "Never force push." })
    ).toEqual({ number: 1, line: "Never force push." });

    const first = await store.status.render();
    expect(first.changed).toBe("first render");
    expect(first.summary.openGateIds).toEqual(["release"]);
    expect(await readFile(join(directory, "status.md"), "utf8")).toContain(
      "| release | open | Ship now? |"
    );
    expect((await store.status.render()).changed).toBe("no derived changes");

    expect(
      await store.gates.resolve({ id: "release", answer: "ship" })
    ).toMatchObject({ kind: "resolved", answer: "ship" });
    expect((await store.status.render()).changed).toBe("open gates 1->0");
    expect(await store.gates.list()).toEqual([]);
    expect(await store.standing.show()).toEqual([
      { number: 1, line: "Never force push." },
    ]);
  });

  it("resolves the ordered Graphite frontier and validates an optional pin", async () => {
    const { directory, store } = await initializedStore();
    const stack = await makeGitStack(directory);
    const output = `◯ main
◯ stack/merged
◯ stack/closed
◉ stack/open (current)
`;

    await withFakeGt({
      directory,
      output,
      operation: async () => {
        expect(await store.frontier.set({ repo: stack.repo })).toEqual({
          generation: 1,
          prs: [
            {
              pr: 10,
              branches: "stack/merged",
              sha: stack.mergedSha,
              state: "MERGED",
            },
            {
              pr: 13,
              branches: "stack/closed",
              sha: stack.closedSha,
              state: "CLOSED",
            },
            {
              pr: 11,
              branches: "stack/open",
              sha: stack.openSha,
              state: "OPEN",
            },
          ],
          lowestUnmerged: 11,
        });
        expect(
          (
            await store.frontier.set({
              repo: stack.repo,
              prs: [10, 13, 11],
            })
          ).generation
        ).toBe(2);
        expect((await store.frontier.show()).generation).toBe(2);
        await expect(
          store.frontier.set({
            repo: stack.repo,
            prs: [10, 11, 12],
          })
        ).rejects.toThrow(
          "frontier pin mismatch: missing from gt: 12; extra in gt: 13"
        );
        await expect(
          store.frontier.set({
            repo: stack.repo,
            prs: [13, 10, 11],
          })
        ).rejects.toThrow(
          "frontier pin mismatch: order differs: expected 13,10,11; gt 10,13,11"
        );
        await expect(
          store.frontier.set({
            repo: stack.repo,
            prs: [10, 10],
          })
        ).rejects.toThrow("--prs must not contain duplicates");
      },
    });
  });

  it("rejects unparseable Graphite output loudly", async () => {
    const { directory, store } = await initializedStore();
    const stack = await makeGitStack(directory);

    await withFakeGt({
      directory,
      output: "◯ main\nthis line is not Graphite output\n",
      operation: async () => {
        await expect(
          store.frontier.set({ repo: stack.repo })
        ).rejects.toThrow(
          'gt log short output has an unparseable line 2: "this line is not Graphite output"'
        );
      },
    });
  });

  it("parses Graphite output that carries colour codes", async () => {
    const { directory, store } = await initializedStore();
    const stack = await makeGitStack(directory);

    await withFakeGt({
      directory,
      output: "\u001b[2m◯ main\u001b[0m\n\u001b[32m◉ stack/open\u001b[39m \u001b[2m(current)\u001b[22m\n",
      operation: async () => {
        expect(
          (await store.frontier.set({ repo: stack.repo })).prs
        ).toEqual([
          { pr: 11, branches: "stack/open", sha: stack.openSha, state: "OPEN" },
        ]);
      },
    });
  });

  it("rejects malformed TSV, verdict, frontier, and inbox data", async () => {
    const { directory, store } = await initializedStore();

    await writeFile(join(directory, "units.tsv"), "wrong\n");
    await expect(store.units.list()).rejects.toThrow(
      "units.tsv has an invalid header"
    );
    await writeFile(
      join(directory, "units.tsv"),
      "id\ttrack\tstate\tbranch\tpr\tsha\tbrief\nshort\trow\n"
    );
    await expect(store.units.list()).rejects.toThrow(
      "units.tsv has a malformed row"
    );

    await writeFile(
      join(directory, "ledger.tsv"),
      "pr\tsha\tverdict\tevidence\tverifier\tts\n1\tsha\tinvalid\treport\tme\tnow\n"
    );
    await expect(store.ledger.summary()).rejects.toThrow(
      "ledger.tsv has invalid verdict invalid"
    );

    await writeFile(join(directory, "frontier.json"), '{"generation":"1"}\n');
    await expect(store.frontier.show()).rejects.toThrow(
      "frontier.json has an invalid shape"
    );

    await writeFile(join(directory, "inbox", "bad.tsv"), "too\tshort\n");
    await expect(store.inbox.peek()).rejects.toThrow(
      "inbox pointer bad.tsv is malformed"
    );
  });

  it("rejects operations after close", async () => {
    const { store } = await initializedStore();
    await store.close();
    await expect(store.units.list()).rejects.toThrow("store is closed");
    await expect(store.status.render()).rejects.toBeInstanceOf(UserError);
  });
});

describe("stack", () => {
  it("adds rows with the merge base as the parent tip and keeps stack.tsv plain", async () => {
    const { directory, repo, mainSha, mergedSha, closedSha } =
      await stackFixture();

    await asActor(directory, "stacker-1", async (store) => {
      expect(
        plain(
          await store.stack.add({
            repo,
            branch: "stack/merged",
            parent: "main",
          })
        )
      ).toEqual({
        branch: "stack/merged",
        parent: "main",
        parentTip: mainSha,
      });
      await store.stack.add({
        repo,
        branch: "stack/closed",
        parent: "stack/merged",
      });
      await store.stack.add({
        repo,
        branch: "stack/open",
        parent: "stack/closed",
      });
    });

    expect(
      (
        await asActor(directory, undefined, (store) => store.stack.show())
      ).map(plain)
    ).toEqual([
      { branch: "stack/merged", parent: "main", parentTip: mainSha },
      { branch: "stack/closed", parent: "stack/merged", parentTip: mergedSha },
      { branch: "stack/open", parent: "stack/closed", parentTip: closedSha },
    ]);
    expect(await readFile(join(directory, "stack.tsv"), "utf8")).toBe(
      `branch\tparent\tparent_tip
stack/merged\tmain\t${mainSha}
stack/closed\tstack/merged\t${mergedSha}
stack/open\tstack/closed\t${closedSha}
`
    );
  });

  it("records the commit the branch was built on after the parent has moved on", async () => {
    const { directory, repo, mainSha } = await stackFixture();
    git({ repo, args: ["checkout", "main"] });
    await writeFile(join(repo, "later.txt"), "later\n");
    git({ repo, args: ["add", "."] });
    git({ repo, args: ["commit", "-m", "later"] });
    expect(git({ repo, args: ["rev-parse", "main"] })).not.toBe(mainSha);

    const row = await asActor(directory, "stacker-1", (store) =>
      store.stack.add({ repo, branch: "stack/merged", parent: "main" })
    );
    expect(String(row.parentTip)).toBe(mainSha);
  });

  it("writes the stack only for the stacker named in the standing orders", async () => {
    const directory = await makeDirectory();
    const { repo } = await makeGitStack(directory);
    const add = (actor: string | undefined) =>
      asActor(directory, actor, (store) =>
        store.stack.add({ repo, branch: "stack/merged", parent: "main" })
      );
    await asActor(directory, undefined, (store) => store.init());

    await expect(add("stacker-1")).rejects.toThrow("no stacker is recorded");

    await asActor(directory, undefined, (store) =>
      store.standing.add({ line: "stacker: stacker-1" })
    );
    await expect(add(undefined)).rejects.toThrow(
      "only the stacker (stacker-1) writes the stack; set --as stacker-1 or ORCH_ACTOR"
    );
    await expect(add("   ")).rejects.toThrow("only the stacker (stacker-1)");
    await expect(add("worker-7")).rejects.toThrow(
      "worker-7 is not the stacker; only stacker-1 writes the stack"
    );
    expect(
      await asActor(directory, undefined, (store) => store.stack.show())
    ).toEqual([]);

    await expect(add("stacker-1")).resolves.toMatchObject({
      branch: "stack/merged",
    });
    await expect(
      asActor(directory, "worker-7", (store) =>
        store.stack.drop({ branch: "stack/merged" })
      )
    ).rejects.toThrow("worker-7 is not the stacker");
    expect(
      await asActor(directory, "worker-7", (store) => store.stack.show())
    ).toHaveLength(1);

    await asActor(directory, undefined, (store) =>
      store.standing.add({ line: "stacker: stacker-2" })
    );
    await expect(add("stacker-1")).rejects.toThrow(
      "records 2 stackers (stacker-1, stacker-2)"
    );
  });

  it("takes an explicit parent tip only when the branch is built on it", async () => {
    const { directory, repo, mainSha, openSha } = await stackFixture();
    const add = (parentTip: string) =>
      asActor(directory, "stacker-1", (store) =>
        store.stack.add({
          repo,
          branch: "stack/closed",
          parent: "stack/merged",
          parentTip,
        })
      );

    await expect(add(openSha)).rejects.toThrow("is not an ancestor");
    await expect(add("abc123")).rejects.toThrow("is not a full commit SHA");
    await expect(add("f".repeat(40))).rejects.toThrow("git merge-base");
    await expect(add(mainSha)).resolves.toMatchObject({ parentTip: mainSha });
  });

  it("refuses a missing branch, a bad name, and a row that is not on top of the stack", async () => {
    const { directory, repo } = await stackFixture();
    const add = (branch: string, parent: string) =>
      asActor(directory, "stacker-1", (store) =>
        store.stack.add({ repo, branch, parent })
      );

    await expect(add("no/such", "main")).rejects.toThrow(
      "branch no/such does not exist"
    );
    await expect(add("--upload-pack=/tmp/pwn", "main")).rejects.toThrow(
      "is not a branch name orch accepts"
    );
    await expect(add("stack/merged", "no/parent")).rejects.toThrow(
      "exists neither locally nor on origin"
    );
    await add("stack/merged", "main");
    await expect(add("stack/open", "main")).rejects.toThrow(
      "must be one chain"
    );
    await expect(add("stack/merged", "main")).rejects.toThrow(
      "lists branch stack/merged twice"
    );
    expect(
      await asActor(directory, undefined, (store) => store.stack.show())
    ).toHaveLength(1);
  });

  it("drops the top or the bottom row and refuses the middle", async () => {
    const { directory, repo } = await stackFixture();
    await asActor(directory, "stacker-1", async (store) => {
      await store.stack.add({ repo, branch: "stack/merged", parent: "main" });
      await store.stack.add({
        repo,
        branch: "stack/closed",
        parent: "stack/merged",
      });
      await store.stack.add({
        repo,
        branch: "stack/open",
        parent: "stack/closed",
      });
      await expect(
        store.stack.drop({ branch: "stack/closed" })
      ).rejects.toThrow("in the middle of the stack");
      await expect(store.stack.drop({ branch: "nope" })).rejects.toThrow(
        "is not in the stack"
      );
      expect(await store.stack.drop({ branch: "stack/open" })).toMatchObject({
        branch: "stack/open",
      });
      expect(await store.stack.drop({ branch: "stack/merged" })).toMatchObject({
        branch: "stack/merged",
      });
      expect((await store.stack.show()).map((row) => String(row.branch))).toEqual(
        ["stack/closed"]
      );
    });
  });

  it("rejects a malformed stack.tsv", async () => {
    const { directory } = await stackFixture();
    const show = () =>
      asActor(directory, undefined, (store) => store.stack.show());

    await writeFile(join(directory, "stack.tsv"), "wrong\n");
    await expect(show()).rejects.toThrow("stack.tsv has an invalid header");
    await writeFile(
      join(directory, "stack.tsv"),
      "branch\tparent\tparent_tip\nonly\ttwo\n"
    );
    await expect(show()).rejects.toThrow("stack.tsv has a malformed row");
    await writeFile(
      join(directory, "stack.tsv"),
      `branch\tparent\tparent_tip\na b\tmain\t${"a".repeat(40)}\n`
    );
    await expect(show()).rejects.toThrow("stack.tsv row 1 branch");
    await rm(join(directory, "stack.tsv"));
    await expect(show()).rejects.toThrow("run orch init");
  });
});

describe("orch CLI", () => {
  it("prints commander help and rejects invalid parsing with exit 1", async () => {
    const help = runCli(["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Commands:");
    expect(help.stdout).toContain("unit");
    expect(help.stdout).toContain("ledger");

    const frontierHelp = runCli(["frontier", "set", "--help"]);
    expect(frontierHelp.code).toBe(0);
    expect(frontierHelp.stdout).toContain("--repo <dir>");
    expect(frontierHelp.stdout).toContain("--prs <n,...>");

    const directory = await makeDirectory();
    const invalid = runCli(["--store", directory, "unit", "add", "u1"]);
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain("required option '--track <track>'");
  });

  it("accepts ORCH_STORE and emits complete JSON", async () => {
    const directory = await makeDirectory();
    const env = { PATH: process.env.PATH, ORCH_STORE: directory };
    expect(runCli(["init"], env).code).toBe(0);

    const added = runCli(
      ["unit", "add", "u1", "--track", "build", "--json"],
      env
    );
    expect(added.code).toBe(0);
    expect(JSON.parse(added.stdout)).toEqual({
      id: "u1",
      track: "build",
      state: "pending",
      branch: "",
      pr: "",
      sha: "",
      brief: "",
    });
  });

  it("maps user and not-found outcomes to the preserved exit codes", async () => {
    const directory = await makeDirectory();
    expect(runCli(["--store", directory, "init"]).code).toBe(0);

    const missingRepo = runCli([
      "--store",
      directory,
      "frontier",
      "set",
    ]);
    expect(missingRepo.code).toBe(1);
    expect(missingRepo.stderr).toContain(
      "set --repo <dir> or ORCH_REPO"
    );

    const userError = runCli([
      "--store",
      directory,
      "unit",
      "add",
      "",
      "--track",
      "build",
    ]);
    expect(userError.code).toBe(1);
    expect(userError.stderr).toContain("unit id must not be empty");

    const missingUnit = runCli([
      "--store",
      directory,
      "unit",
      "get",
      "missing",
    ]);
    expect(missingUnit.code).toBe(2);
    expect(missingUnit.stderr).toContain("unit missing not found");

    const missingLedger = runCli([
      "--store",
      directory,
      "--json",
      "ledger",
      "check",
      "184530",
      "abc123",
    ]);
    expect(missingLedger.code).toBe(2);
    expect(JSON.parse(missingLedger.stdout)).toEqual({
      pr: "184530",
      sha: "abc123",
      verdict: "NOT-VERIFIED",
    });
    expect(missingLedger.stderr).toBe("");
  });
});

describe("port guards", () => {
  it("rejects a parenthesized gt PR status instead of treating it as open", async () => {
    const { directory, store } = await initializedStore();
    const stack = await makeGitStack(directory);

    await withFakeGt({
      directory,
      output: "◯ main\n◉ stack/paren\n",
      operation: async () => {
        const gt = fakeGtPath(directory);
        await rename(gt, `${gt}-base`);
        await writeFile(
          gt,
          `#!/usr/bin/env bash
if [ "$*" = "--no-interactive info stack/paren" ]; then
  printf 'stack/paren\\nPR #14 (Needs approvals (2)) tricky change\\n'
else
  exec "${gt}-base" "$@"
fi
`,
          { mode: 0o755 }
        );
        await expect(store.frontier.set({ repo: stack.repo })).rejects.toThrow(
          "gt info output has an invalid PR row for branch stack/paren"
        );
      },
    });
  });

  it("rejects a leading-dash branch name in gt log output", async () => {
    const { directory, store } = await initializedStore();
    const stack = await makeGitStack(directory);

    await withFakeGt({
      directory,
      output: "◯ main\n◉ --upload-pack=/tmp/pwn\n",
      operation: async () => {
        await expect(store.frontier.set({ repo: stack.repo })).rejects.toThrow(
          "gt log short output has an unparseable line 2"
        );
      },
    });
  });

  it("keeps status.md table cells single-line when frontier data carries control characters", async () => {
    const { directory, store } = await initializedStore();

    await writeFile(
      join(directory, "frontier.json"),
      `${JSON.stringify({
        generation: 1,
        prs: [{ pr: 7, branches: "a\nb|c", sha: "cafe\tf00d", state: "OPEN" }],
        lowestUnmerged: 7,
      })}\n`
    );
    await store.status.render();
    const status = await readFile(join(directory, "status.md"), "utf8");
    expect(status).toContain("| a b\\|c | 7 | cafe f00d | OPEN |");
  });
});

describe("orch stack CLI", () => {
  it("adds, shows, and drops rows for the stacker and refuses a worker", async () => {
    const { directory, repo, mainSha } = await stackFixture();
    const base = ["--store", directory];
    const add = (as: string | undefined, env?: Record<string, string>) =>
      runCli(
        [
          ...base,
          ...(as === undefined ? [] : ["--as", as]),
          "stack",
          "add",
          "stack/merged",
          "--parent",
          "main",
          "--repo",
          repo,
        ],
        { PATH: process.env.PATH, ...env }
      );

    const refused = add("worker-7");
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("worker-7 is not the stacker");
    expect(add(undefined).stderr).toContain("set --as stacker-1 or ORCH_ACTOR");

    const added = add(undefined, { ORCH_ACTOR: "stacker-1" });
    expect(added.code).toBe(0);
    expect(added.stdout).toBe(`stack/merged\tmain\t${mainSha}\n`);

    const shown = runCli([...base, "stack", "show"]);
    expect(shown.stdout).toBe(`stack/merged\tmain\t${mainSha}\n`);
    expect(JSON.parse(runCli([...base, "--json", "stack", "show"]).stdout)).toEqual([
      { branch: "stack/merged", parent: "main", parentTip: mainSha },
    ]);

    const dropped = runCli([
      ...base,
      "--as",
      "stacker-1",
      "stack",
      "drop",
      "stack/merged",
    ]);
    expect(dropped.code).toBe(0);
    expect(runCli([...base, "stack", "show"]).stdout).toBe("(no stack)\n");
  });

  it("needs --repo for add", async () => {
    const { directory } = await stackFixture();
    const result = runCli(
      ["--store", directory, "--as", "stacker-1", "stack", "add", "x", "--parent", "main"],
      { PATH: process.env.PATH }
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("set --repo <dir> or ORCH_REPO");
  });
});
