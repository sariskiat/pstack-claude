import { describe, expect, it } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForgeError } from "../forge/forge.ts";
import { WatchDeadline } from "./deadline.ts";
import {
  GhGitHubReader,
  orderStack,
  parsePullRequest,
  WatcherQueryError,
} from "./github.ts";
import {
  parseContext,
  parseLandingRevision,
  sameLandingRevision,
  type LandingRevision,
} from "./landing.ts";
import { renderStatusTable } from "./render.ts";
import {
  cancelPending,
  GhShippingService,
  parseLandingRecord,
} from "./shipping.ts";
import { parsePrNumber, type PrContext } from "./types.ts";

const number = parsePrNumber(42);
const githubContext: PrContext = {
  host: "github.com",
  path: "owner/repo",
  number,
};

function rejection(run: () => unknown): WatcherQueryError {
  try {
    run();
  } catch (error) {
    if (error instanceof WatcherQueryError) return error;
    throw error;
  }
  throw new Error("expected a WatcherQueryError");
}

describe("parseContext with a host and path", () => {
  it("accepts a github.com project and a nested gitlab group path", () => {
    expect(
      parseContext({ host: "github.com", path: "o/r", number: 1 })
    ).toEqual({
      host: "github.com",
      path: "o/r",
      number: parsePrNumber(1),
    });
    expect(
      parseContext({
        host: "gitlab.cjexpress.io",
        path: "a/b.c/d_e-f",
        number: 2,
      }).path
    ).toBe("a/b.c/d_e-f");
  });

  it("rejects a path that could be read as an option, a traversal, or a name with a space", () => {
    for (const path of [
      "--flag",
      "o/--flag",
      "--flag/r",
      "../../etc",
      "o/..",
      "./r",
      "a b/r",
      "o/r r",
      "o//r",
      "/o/r",
      "o/r/",
      "solo",
      "o/r?x=1",
      "o/r%2e",
    ])
      expect(
        rejection(() => parseContext({ host: "github.com", path, number: 1 }))
          .failure
      ).toMatchObject({ kind: "missing-key", retryable: true });
  });

  it("rejects a host that is not a plain hostname", () => {
    for (const host of [
      "",
      "-x",
      "--flag",
      "a b",
      "h/x",
      "h:8443",
      "h@x",
      "h?x",
      "h.com/..",
    ])
      expect(() => parseContext({ host, path: "o/r", number: 1 })).toThrow(
        WatcherQueryError
      );
  });

  it("keeps the owner/repo wire shape reading the way it did", () => {
    expect(parseContext({ owner: "Acme", repo: "web", number: 7 })).toEqual({
      host: "github.com",
      path: "Acme/web",
      number: parsePrNumber(7),
    });
  });
});

describe("a saved landing record is a trust boundary", () => {
  const record = (context: unknown): unknown => ({
    revision: {
      context,
      headRefOid: "h",
      baseRefName: "main",
      baseRefOid: "b",
    },
    pullRequestId: "PR_1",
    state: "OPEN",
    pending: { autoMerge: false, queueEntryId: null },
    mergeCommitOid: null,
  });

  it("refuses a record whose context path is an option", () => {
    expect(() =>
      parseLandingRecord(
        record({ host: "github.com", path: "--flag", number: 1 })
      )
    ).toThrow(WatcherQueryError);
  });

  it("a github.com record with three path segments reports unavailable and never throws or calls gh", async () => {
    const calls: string[][] = [];
    const service = new GhShippingService(async (argv) => {
      calls.push([...argv]);
      return {};
    });
    const parsed = parseLandingRecord(
      record({ host: "github.com", path: "a/b/c", number: 1 })
    );
    const result = await cancelPending(service, parsed);
    expect(result.kind).toBe("unavailable");
    expect(calls).toEqual([]);
  });
});

describe("sameLandingRevision compares the host", () => {
  const revision = (
    context: PrContext,
    over: Partial<LandingRevision> = {}
  ): LandingRevision => ({
    context,
    headRefOid: "h",
    baseRefName: "main",
    baseRefOid: "b",
    ...over,
  });

  it("is false when only the host differs", () => {
    expect(
      sameLandingRevision(
        revision(githubContext),
        revision({ ...githubContext, host: "gitlab.example.com" })
      )
    ).toBe(false);
  });

  it("ignores case in the host and the path, and nothing else", () => {
    const upper: PrContext = { host: "GitHub.com", path: "OWNER/Repo", number };
    expect(sameLandingRevision(revision(githubContext), revision(upper))).toBe(
      true
    );
    expect(
      sameLandingRevision(
        revision(githubContext),
        revision({ ...githubContext, number: parsePrNumber(43) })
      )
    ).toBe(false);
    expect(
      sameLandingRevision(
        revision(githubContext),
        revision(githubContext, { headRefOid: "x" })
      )
    ).toBe(false);
  });

  it("parseLandingRevision keeps the host it was given", () => {
    const gitlab: PrContext = {
      host: "gitlab.example.com",
      path: "g/p",
      number,
    };
    expect(
      parseLandingRevision(
        { headRefOid: "h", baseRefName: "m", baseRefOid: "b" },
        gitlab
      ).context
    ).toEqual(gitlab);
  });
});

describe("orderStack treats a same-path repository on another host as foreign", () => {
  it("does not link a PR whose head repository is on a different host", () => {
    const ordered = orderStack(githubContext, [
      {
        number: parsePrNumber(41),
        headRepository: { host: "gitlab.example.com", path: "owner/repo" },
        headRefName: "base-feature",
        baseRefName: "main",
      },
      {
        number,
        headRepository: { host: "github.com", path: "owner/repo" },
        headRefName: "feature",
        baseRefName: "base-feature",
      },
    ]);
    expect(ordered.map((item) => Number(item.number))).toEqual([42]);
  });

  it("still links a local parent whose host differs only by case in the path", () => {
    const ordered = orderStack(githubContext, [
      {
        number: parsePrNumber(41),
        headRepository: { host: "github.com", path: "OWNER/REPO" },
        headRefName: "base-feature",
        baseRefName: "main",
      },
      {
        number,
        headRepository: { host: "github.com", path: "owner/repo" },
        headRefName: "feature",
        baseRefName: "base-feature",
      },
    ]);
    expect(ordered.map((item) => Number(item.number))).toEqual([41, 42]);
  });
});

describe("renderStatusTable builds the link from the row's host and path", () => {
  const closed = (context: PrContext) => ({
    kind: "closed" as const,
    context,
    facts: parsePullRequest(
      {
        mergeable: "UNKNOWN",
        mergeStateStatus: "UNKNOWN",
        reviewDecision: "",
        headRefOid: null,
        baseRefOid: null,
        headRefName: "f",
        baseRefName: "main",
        state: "CLOSED",
        mergedAt: null,
        isDraft: false,
      },
      context
    ),
  });

  it("links a github.com row to github.com", () => {
    expect(renderStatusTable([closed(githubContext)])).toContain(
      "[#42](https://github.com/owner/repo/pull/42)"
    );
  });

  it("links a nested-group row on another host to that host and the whole path", () => {
    const nested: PrContext = {
      host: "gitlab.example.com",
      path: "g/sub/p",
      number,
    };
    expect(renderStatusTable([closed(nested)])).toContain(
      "[#42](https://gitlab.example.com/g/sub/p/-/merge_requests/42)"
    );
  });
});

describe("a repository named .github and the shared segment rule", () => {
  it("parseContext accepts .github, and rejects dot segments, a leading dash, and .git", () => {
    expect(
      parseContext({ host: "github.com", path: "acme/.github", number: 1 }).path
    ).toBe("acme/.github");
    expect(
      parseContext({ owner: "acme", repo: ".github", number: 1 }).path
    ).toBe("acme/.github");
    for (const path of ["a/.", "a/..", "./b", "../b", "a/-x", "-a/b", "a/.git"])
      expect(() =>
        parseContext({ host: "github.com", path, number: 1 })
      ).toThrow(WatcherQueryError);
  });

  it("the legacy owner and repo branch rejects options, dots, and .git", () => {
    for (const [owner, repo] of [
      ["--x", "r"],
      ["o", "--x"],
      ["..", "r"],
      ["o", ".."],
      ["o", "."],
      ["o", ".git"],
      [".git", "r"],
    ])
      expect(() => parseContext({ owner, repo, number: 1 })).toThrow(
        WatcherQueryError
      );
  });
});

describe("a record for another forge never reaches gh", () => {
  const gitlab: PrContext = {
    host: "gitlab.cjexpress.io",
    path: "g/p",
    number,
  };

  it("GhShippingService.inspect rejects a non-github host without running gh", async () => {
    const calls: string[][] = [];
    const service = new GhShippingService(async (argv) => {
      calls.push([...argv]);
      return {};
    });
    await expect(service.inspect(gitlab)).rejects.toMatchObject({
      name: "ForgeError",
      code: "not-github-host",
    });
    expect(calls).toEqual([]);
  });

  it("GhGitHubReader rejects a non-github host before running gh", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-gh-"));
    const saved = process.env.PATH;
    const marker = join(dir, "ran");
    try {
      await writeFile(
        join(dir, "gh"),
        `#!/bin/sh\necho x > ${marker}\necho '{}'\n`
      );
      await chmod(join(dir, "gh"), 0o755);
      process.env.PATH = `${dir}:${saved}`;
      const reader = new GhGitHubReader(new WatchDeadline(0, () => 0));
      await expect(reader.pullRequest(gitlab)).rejects.toBeInstanceOf(
        ForgeError
      );
      await expect(reader.checkRollupPage(gitlab, null)).rejects.toBeInstanceOf(
        ForgeError
      );
      expect(await Bun.file(marker).exists()).toBe(false);
    } finally {
      process.env.PATH = saved;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
