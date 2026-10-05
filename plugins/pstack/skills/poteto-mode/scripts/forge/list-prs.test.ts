import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForgeError } from "./forge.ts";
import { listOwnPullRequests, type ListedPr } from "./list-prs.ts";

const HOST = "gitlab.example.com";
const SHA = "a".repeat(40);

interface Call {
  readonly tool: string;
  readonly args: string[];
  readonly cwd: string;
}

interface Fakes {
  readonly root: string;
  readonly calls: () => Call[];
  checkout(remote: string | null): string;
}

async function withFakes(
  scripts: { readonly gh?: string; readonly glab?: string },
  run: (fakes: Fakes) => Promise<void>
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "list-prs-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const callsFile = join(root, "calls.jsonl");
  writeFileSync(callsFile, "");
  for (const [name, body] of Object.entries(scripts)) {
    writeFileSync(
      join(bin, name),
      `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'warm') process.exit(0);
appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ tool: ${JSON.stringify(name)}, args, cwd: process.cwd() }) + '\\n');
${body}
`
    );
    chmodSync(join(bin, name), 0o755);
    spawnSync(join(bin, name), ["warm"]);
  }
  const saved = process.env.PATH;
  let count = 0;
  try {
    process.env.PATH = `${bin}:${saved}`;
    await run({
      root,
      calls: () =>
        readFileSync(callsFile, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
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

const GH_JSON: readonly ListedPr[] = [
  { number: 7, state: "OPEN", headRefName: "open", headRefOid: SHA },
  { number: 8, state: "MERGED", headRefName: "merged", headRefOid: SHA },
];

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}
const messageOf = async (promise: Promise<unknown>): Promise<string> =>
  ((await rejection(promise)) as Error).message;
const codeOf = async (promise: Promise<unknown>): Promise<string> =>
  ((await rejection(promise)) as ForgeError).code;
const ghScript = `console.log(JSON.stringify(${JSON.stringify(GH_JSON)}));`;
const NO_GITHUB_REMOTE =
  "none of the git remotes configured for this repository point to a known GitHub host. To tell gh about a new GitHub host, please use `gh auth login`";
const ghFindsNoRemote = `console.error(${JSON.stringify(NO_GITHUB_REMOTE)}); process.exit(1);`;

const mr = (iid: number, state: string, branch = `b${iid}`) => ({
  iid,
  state,
  source_branch: branch,
  sha: SHA,
});
const glabScript = (pages: Record<string, unknown>, extra = "") => `
if (args[0] === 'auth') { console.log('${HOST}'); process.exit(0); }
const endpoint = args[args.length - 1];
const page = /[?&]page=(\\d+)/.exec(endpoint)?.[1] ?? '1';
${extra}
console.log(JSON.stringify(${JSON.stringify(pages)}[page] ?? []));
`;

describe("a GitHub checkout lists through gh exactly as the worktree audit did", () => {
  test("runs gh pr list with the audit's arguments in the checkout and returns its list", async () => {
    await withFakes({ gh: ghScript }, async (fakes) => {
      const dir = fakes.checkout("https://github.com/o/r.git");
      expect(await listOwnPullRequests(dir)).toEqual(GH_JSON);
      const [call] = fakes.calls();
      expect(call.args).toEqual([
        "pr",
        "list",
        "--author",
        "@me",
        "--state",
        "all",
        "--limit",
        "1000",
        "--json",
        "number,state,headRefName,headRefOid",
      ]);
      expect(call.cwd).toBe(
        execFileSync("realpath", [dir], { encoding: "utf8" }).trim()
      );
    });
  });

  test("keeps gh for a checkout with no origin remote", async () => {
    await withFakes({ gh: ghScript }, async (fakes) => {
      expect(await listOwnPullRequests(fakes.checkout(null))).toEqual(GH_JSON);
    });
  });

  test("an SSH host alias and ssh.github.com on port 443 list through gh as before GitLab support", async () => {
    await withFakes(
      { gh: ghScript, glab: `console.log('${HOST}');` },
      async (fakes) => {
        for (const remote of [
          "git@github.com-work:o/r.git",
          "ssh://git@ssh.github.com:443/o/r.git",
        ])
          expect(await listOwnPullRequests(fakes.checkout(remote))).toEqual(
            GH_JSON
          );
        expect(fakes.calls().filter((call) => call.tool === "gh")).toHaveLength(
          2
        );
      }
    );
  });

  test("reports a gh failure with its first line", async () => {
    await withFakes(
      {
        gh: "console.error('gh: not logged in\\nsecond line'); process.exit(4);",
      },
      async (fakes) => {
        expect(
          await messageOf(
            listOwnPullRequests(fakes.checkout("https://github.com/o/r"))
          )
        ).toBe("gh pr list failed: gh: not logged in");
      }
    );
  });
});

describe("a GitLab checkout lists its own merge requests through glab", () => {
  const remote = `https://${HOST}/platform/team/app.git`;

  test("reads the created_by_me list of the whole group path and names each merge request with its iid", async () => {
    await withFakes(
      {
        glab: glabScript({
          "1": [
            mr(3, "opened", "feature/x"),
            mr(4, "merged"),
            mr(5, "closed"),
            mr(6, "locked"),
          ],
        }),
      },
      async (fakes) => {
        const listed = await listOwnPullRequests(fakes.checkout(remote));
        expect(listed).toEqual([
          {
            number: 3,
            state: "OPEN",
            headRefName: "feature/x",
            headRefOid: SHA,
            ref: "!3",
          },
          {
            number: 4,
            state: "MERGED",
            headRefName: "b4",
            headRefOid: SHA,
            ref: "!4",
          },
          {
            number: 5,
            state: "CLOSED",
            headRefName: "b5",
            headRefOid: SHA,
            ref: "!5",
          },
          {
            number: 6,
            state: "OPEN",
            headRefName: "b6",
            headRefOid: SHA,
            ref: "!6",
          },
        ]);
        const [, api] = fakes.calls();
        expect(api.args).toEqual([
          "api",
          "--hostname",
          HOST,
          "projects/platform%2Fteam%2Fapp/merge_requests?scope=created_by_me&state=all&order_by=updated_at&per_page=100&page=1",
        ]);
      }
    );
  });

  test("reads the next page while a page is full", async () => {
    const full = Array.from({ length: 100 }, (_, n) => mr(n + 1, "opened"));
    await withFakes(
      { glab: glabScript({ "1": full, "2": [mr(101, "merged")] }) },
      async (fakes) => {
        const listed = await listOwnPullRequests(fakes.checkout(remote));
        expect(listed).toHaveLength(101);
        const pages = fakes
          .calls()
          .filter((call) => call.args[0] === "api")
          .map((call) => /page=(\d+)$/.exec(call.args[3])?.[1]);
        expect(pages).toEqual(["1", "2"]);
      }
    );
  });

  test("refuses a list it cannot finish", async () => {
    const full = Array.from({ length: 100 }, (_, n) => mr(n + 1, "opened"));
    const pages = Object.fromEntries(
      Array.from({ length: 10 }, (_, n) => [String(n + 1), full])
    );
    await withFakes({ glab: glabScript(pages) }, async (fakes) => {
      expect(
        await messageOf(listOwnPullRequests(fakes.checkout(remote)))
      ).toContain("partial list is refused");
    });
  });

  test("fails on a glab error with its first line, and on a merge request in the wrong shape", async () => {
    await withFakes(
      {
        glab: `
if (args[0] === 'auth') { console.log('${HOST}'); process.exit(0); }
console.error('glab: 401 Unauthorized (HTTP 401)'); process.exit(1);`,
      },
      async (fakes) => {
        expect(
          await messageOf(listOwnPullRequests(fakes.checkout(remote)))
        ).toBe("glab api failed: glab: 401 Unauthorized (HTTP 401)");
      }
    );
    await withFakes(
      { glab: glabScript({ "1": [{ iid: "3", state: "opened" }] }) },
      async (fakes) => {
        expect(
          await messageOf(listOwnPullRequests(fakes.checkout(remote)))
        ).toContain("not in the expected shape");
      }
    );
  });

  test("a sha that is not a commit id is refused", async () => {
    await withFakes(
      {
        glab: glabScript({
          "1": [{ ...mr(3, "opened"), sha: "--upload-pack=x" }],
        }),
      },
      async (fakes) => {
        expect(
          await messageOf(listOwnPullRequests(fakes.checkout(remote)))
        ).toContain("not in the expected shape");
      }
    );
  });

  test("a host glab does not list fails with unknown-host, and a hung glab with glab-timeout, once gh finds no GitHub remote", async () => {
    await withFakes(
      { glab: "console.log('gitlab.com');", gh: ghFindsNoRemote },
      async (fakes) => {
        const error = (await rejection(
          listOwnPullRequests(fakes.checkout(remote))
        )) as ForgeError;
        expect(error.code).toBe("unknown-host");
        expect(error.message).toContain(`glab auth login --hostname ${HOST}`);
        expect(error.message).toContain(
          `gh could not read the repository either: ${NO_GITHUB_REMOTE}`
        );
      }
    );
    await withFakes(
      {
        glab: "await new Promise((r) => setTimeout(r, 5000));",
        gh: ghFindsNoRemote,
      },
      async (fakes) => {
        expect(
          await codeOf(
            listOwnPullRequests(fakes.checkout(remote), { glabTimeoutMs: 300 })
          )
        ).toBe("glab-timeout");
      }
    );
  });
});

describe("the command line", () => {
  const script = join(import.meta.dir, "list-prs.ts");

  test("prints the list as one JSON line", async () => {
    await withFakes({ gh: ghScript }, async (fakes) => {
      const result = spawnSync(
        process.execPath,
        [script, fakes.checkout("https://github.com/o/r")],
        {
          encoding: "utf8",
          env: process.env,
        }
      );
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(GH_JSON);
    });
  });

  test("exits 1 and prints the ForgeError code when the forge cannot be resolved", async () => {
    await withFakes(
      { glab: "console.log('gitlab.com');", gh: ghFindsNoRemote },
      async (fakes) => {
        const result = spawnSync(
          process.execPath,
          [script, fakes.checkout(`https://${HOST}/g/p.git`)],
          { encoding: "utf8", env: process.env }
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("ForgeError[unknown-host]");
        expect(result.stdout).toBe("");
      }
    );
  });
});
