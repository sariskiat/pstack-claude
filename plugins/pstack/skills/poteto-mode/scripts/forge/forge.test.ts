import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ForgeError,
  parseGlabHosts,
  parseRemoteUrl,
  resolveCheckoutForge,
  resolveForge,
  type ForgeEnv,
  type ResolvedForge,
} from "./forge.ts";

const GITLAB = "gitlab.cjexpress.io";
const env = (over: Partial<ForgeEnv> = {}): ForgeEnv => ({
  gitlabHosts: [GITLAB],
  originOnPath: false,
  ...over,
});

function failure(run: () => unknown): ForgeError {
  try {
    run();
  } catch (error) {
    if (error instanceof ForgeError) return error;
    throw error;
  }
  throw new Error("expected a ForgeError");
}

describe("resolveForge", () => {
  test("a github.com https remote resolves to github", () => {
    expect(
      resolveForge("https://github.com/sariskiat/pstack-sandbox.git", env())
    ).toEqual({
      kind: "github",
      project: { host: "github.com", path: "sariskiat/pstack-sandbox" },
    });
  });

  test("a github.com ssh remote resolves to the same project", () => {
    const expected: ResolvedForge = {
      kind: "github",
      project: { host: "github.com", path: "sariskiat/pstack-sandbox" },
    };
    expect(
      resolveForge("git@github.com:sariskiat/pstack-sandbox.git", env())
    ).toEqual(expected);
    expect(
      resolveForge("ssh://git@github.com/sariskiat/pstack-sandbox", env())
    ).toEqual(expected);
  });

  test("a listed gitlab host keeps every nested group segment", () => {
    expect(
      resolveForge(`https://${GITLAB}/platform/tools/team/app.git`, env())
    ).toEqual({
      kind: "gitlab",
      project: { host: GITLAB, path: "platform/tools/team/app" },
    });
  });

  test("gitlab https, scp ssh, and ssh url remotes name the same project", () => {
    const remotes = [
      `https://${GITLAB}/saris.kia/pstack-sandbox.git`,
      `git@${GITLAB}:saris.kia/pstack-sandbox.git`,
      `ssh://git@${GITLAB}:2222/saris.kia/pstack-sandbox.git`,
    ];
    const resolved = remotes.map((remote) => resolveForge(remote, env()));
    for (const forge of resolved)
      expect(forge).toEqual({
        kind: "gitlab",
        project: { host: GITLAB, path: "saris.kia/pstack-sandbox" },
      });
  });

  test("an unknown host fails with a named error that names the host", () => {
    const error = failure(() =>
      resolveForge("https://git.example.net/a/b.git", env())
    );
    expect(error.code).toBe("unknown-host");
    expect(error.message).toContain("git.example.net");
  });

  test("host matching ignores case", () => {
    expect(resolveForge("https://GitLab.CJExpress.io/a/b", env()).kind).toBe(
      "gitlab"
    );
  });

  test("origin wins over gitlab and github when its CLI is on PATH", () => {
    const on = env({ originOnPath: true });
    expect(resolveForge("https://github.com/o/r", on).kind).toBe("origin");
    expect(resolveForge(`https://${GITLAB}/g/p`, on).kind).toBe("origin");
  });

  test("a gitlab host that glab does not list is unknown", () => {
    const error = failure(() =>
      resolveForge(`https://${GITLAB}/g/p`, env({ gitlabHosts: [] }))
    );
    expect(error.code).toBe("unknown-host");
  });

  test("a remote with credentials never leaks them into the result or the error", () => {
    const secret = "tok3n-s3cret";
    const ok = resolveForge(
      `https://oauth2:${secret}@${GITLAB}/g/p.git`,
      env()
    );
    expect(JSON.stringify(ok)).not.toContain(secret);
    const bad = failure(() =>
      resolveForge(`https://oauth2:${secret}@git.example.net/g/p`, env())
    );
    expect(bad.message).not.toContain(secret);
  });

  test("a remote without a group and project path is unparseable", () => {
    for (const remote of [
      "https://github.com/only-one",
      "https://github.com/",
      "not a remote",
      "file:///tmp/repo",
    ])
      expect(failure(() => resolveForge(remote, env())).code).toBe(
        "unparseable-remote"
      );
  });
});

describe("parseRemoteUrl", () => {
  test("strips a trailing .git and a trailing slash", () => {
    expect(parseRemoteUrl("https://github.com/o/r.git/")).toEqual({
      host: "github.com",
      path: "o/r",
    });
  });
});

describe("parseGlabHosts", () => {
  test("lists every host header, including one that fails auth", () => {
    const output = [
      "gitlab.com",
      "  x gitlab.com: API call failed: GET https://gitlab.com/api/v4/user: 401",
      "gitlab.cjexpress.io",
      "  ✓ Logged in to gitlab.cjexpress.io as saris.kia",
      "",
      "  X could not authenticate to one or more of the configured GitLab instances..",
    ].join("\n");
    expect(parseGlabHosts(output)).toEqual([
      "gitlab.com",
      "gitlab.cjexpress.io",
    ]);
  });
});

describe("resolveCheckoutForge", () => {
  test("a checkout with no origin remote fails and names the remote", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-noremote-"));
    try {
      Bun.spawnSync(["git", "init", "-q", dir]);
      const error = await resolveCheckoutForge(dir).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ForgeError);
      expect((error as ForgeError).code).toBe("no-origin-remote");
      expect((error as ForgeError).message).toContain("origin");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
