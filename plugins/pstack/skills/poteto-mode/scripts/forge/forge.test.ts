import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  currentBranch,
  checkoutForge,
  detectForgeEnv,
  ForgeError,
  ghFoundNoRepository,
  GLAB_TIMEOUT_MS,
  ownerAndName,
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

describe("parseRemoteUrl on malformed escapes", () => {
  test("a bad percent escape is an unparseable-remote ForgeError, not a URIError", () => {
    for (const remote of ["https://x.io/a/%E0%A4%A", "https://u:%zz@h/%zz/r"])
      expect(failure(() => parseRemoteUrl(remote)).code).toBe(
        "unparseable-remote"
      );
  });

  test("the error text does not echo the credential part", () => {
    const error = failure(() => parseRemoteUrl("https://u:s3cret%zz@h/%zz/r"));
    expect(error.message).not.toContain("s3cret");
  });
});

describe("one host rule for every transport", () => {
  test("https with a port, ssh with a port, and scp name the same host", () => {
    const remotes = [
      `https://${GITLAB}:8443/g/p.git`,
      `ssh://git@${GITLAB}:2222/g/p.git`,
      `git@${GITLAB}:g/p.git`,
      `https://${GITLAB}/g/p.git`,
    ];
    for (const remote of remotes)
      expect(parseRemoteUrl(remote)).toEqual({ host: GITLAB, path: "g/p" });
  });

  test("a glab host listed with a port still matches the port-free host", () => {
    expect(
      resolveForge(
        `https://${GITLAB}:8443/g/p`,
        env({ gitlabHosts: [`${GITLAB}:8443`] })
      ).kind
    ).toBe("gitlab");
  });
});

describe("ownerAndName", () => {
  test("returns owner and name for exactly two segments", () => {
    expect(ownerAndName({ host: "github.com", path: "o/r" })).toEqual({
      owner: "o",
      name: "r",
    });
  });

  test("rejects a nested group path, a single segment, and an empty segment", () => {
    for (const path of ["a/b/c", "a/b/c/d", "solo", "a//b", "/b", "a/"])
      expect(
        failure(() => ownerAndName({ host: "github.com", path })).code
      ).toBe("not-owner-repo");
  });
});

async function withFakeBins(
  bins: Record<string, string>,
  run: (dir: string) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "forge-bins-"));
  const saved = process.env.PATH;
  try {
    for (const [name, body] of Object.entries(bins)) {
      await writeFile(join(dir, name), `#!/bin/sh\n${body}\n`);
      await chmod(join(dir, name), 0o755);
    }
    process.env.PATH = `${dir}:${saved}`;
    await run(dir);
  } finally {
    process.env.PATH = saved;
    await rm(dir, { recursive: true, force: true });
  }
}

describe("detectForgeEnv glab cost", () => {
  const glabRan = (dir: string): Promise<boolean> =>
    readFile(join(dir, "glab-ran")).then(
      () => true,
      () => false
    );

  test("a github.com remote never runs glab", async () => {
    await withFakeBins(
      { glab: 'touch "$(dirname "$0")/glab-ran"' },
      async (dir) => {
        const forge = await detectForgeEnv("github.com");
        expect(await glabRan(dir)).toBe(false);
        expect(forge.gitlabHosts).toEqual([]);
      }
    );
  });

  test("an origin CLI on PATH never runs glab", async () => {
    await withFakeBins(
      { glab: 'touch "$(dirname "$0")/glab-ran"', origin: "exit 0" },
      async (dir) => {
        const forge = await detectForgeEnv(GITLAB);
        expect(await glabRan(dir)).toBe(false);
        expect(forge.originOnPath).toBe(true);
      }
    );
  });

  test("a hung glab is killed at the timeout and lists no hosts", async () => {
    await withFakeBins({ glab: "sleep 5" }, async () => {
      const started = performance.now();
      const forge = await detectForgeEnv(GITLAB, { glabTimeoutMs: 300 });
      const elapsed = performance.now() - started;
      expect(forge.gitlabHosts).toEqual([]);
      expect(forge.glabFailure).toEqual({ kind: "timed-out", afterMs: 300 });
      expect(elapsed).toBeGreaterThanOrEqual(250);
      expect(elapsed).toBeLessThan(2000);
    });
  });

  test("a gitlab host still reads its glab host list", async () => {
    await withFakeBins({ glab: `printf '${GITLAB}\\n  ok\\n'` }, async () => {
      const forge = await detectForgeEnv(GITLAB, { glabTimeoutMs: 60_000 });
      expect(forge.gitlabHosts).toEqual([GITLAB]);
    });
  });
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function pidFrom(file: string): Promise<number> {
  for (let i = 0; i < 50; i++) {
    const text = await readFile(file, "utf8").catch(() => "");
    if (text.trim() !== "") return Number(text.trim());
    await Bun.sleep(20);
  }
  throw new Error("fake binary never wrote its pid");
}

const KILL_TIMEOUT_MS = 5000;

describe("a timed-out glab leaves no process behind", () => {
  async function withGlab(
    body: (pidFile: string) => string,
    run: (pidFile: string) => Promise<void>
  ): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "forge-kill-"));
    const saved = process.env.PATH;
    const pidFile = join(dir, "pid");
    try {
      await writeFile(
        join(dir, "glab"),
        `#!/bin/sh\n[ "$1" = warm ] && exit 0\n${body(pidFile)}\n`
      );
      await chmod(join(dir, "glab"), 0o755);
      await Bun.spawn([join(dir, "glab"), "warm"]).exited;
      process.env.PATH = `${dir}:${saved}`;
      await run(pidFile);
    } finally {
      process.env.PATH = saved;
      await rm(dir, { recursive: true, force: true });
    }
  }

  test("the direct child is dead after the call", async () => {
    await withGlab(
      (pidFile) => `echo $$ > ${pidFile}\nexec sleep 62`,
      async (pidFile) => {
        await detectForgeEnv(GITLAB, { glabTimeoutMs: KILL_TIMEOUT_MS });
        const pid = await pidFrom(pidFile);
        await Bun.sleep(100);
        expect(alive(pid)).toBe(false);
      }
    );
  }, 30_000);

  test("a grandchild of a wrapper script is dead after the call", async () => {
    await withGlab(
      (pidFile) => `sh -c 'echo $$ > ${pidFile}; exec sleep 62' &\nwait`,
      async (pidFile) => {
        await detectForgeEnv(GITLAB, { glabTimeoutMs: KILL_TIMEOUT_MS });
        const pid = await pidFrom(pidFile);
        await Bun.sleep(100);
        const stillAlive = alive(pid);
        if (stillAlive) process.kill(pid, "SIGKILL");
        expect(stillAlive).toBe(false);
      }
    );
  }, 30_000);
});

describe("one segment rule and one host rule for remotes", () => {
  test("a repository named .github is a valid segment", () => {
    expect(parseRemoteUrl("https://github.com/acme/.github.git").path).toBe(
      "acme/.github"
    );
    expect(parseRemoteUrl("git@github.com:acme/.github").path).toBe(
      "acme/.github"
    );
  });

  test("a segment that is an option, a dot, or holds control, space, or encoded slash text is unparseable", () => {
    for (const path of [
      "a/%0A/b",
      "a/%00/b",
      "a/b%20c",
      "a/--flag",
      "a/-x",
      "a/%2F/b",
      "a/%2f/b",
      "a/../b",
      "a/b/..",
    ])
      expect(
        failure(() => parseRemoteUrl(`https://gitlab.cjexpress.io/${path}`))
          .code
      ).toBe("unparseable-remote");
  });

  test("an scp remote with a bad segment is unparseable", () => {
    for (const path of ["a/--flag", "a/b c", "a/../b"])
      expect(
        failure(() => parseRemoteUrl(`git@gitlab.cjexpress.io:${path}`)).code
      ).toBe("unparseable-remote");
  });

  test("an scp or url host that is not a hostname is unparseable", () => {
    for (const remote of [
      "git@[::1]:a/b",
      "-oProxyCommand=x:a/b",
      "git@-bad.io:a/b",
      "https://[::1]/a/b",
    ])
      expect(failure(() => parseRemoteUrl(remote)).code).toBe(
        "unparseable-remote"
      );
  });

  test("errors never echo the raw remote or path", () => {
    const remote = "https://gitlab.cjexpress.io/a/%0Aevil/b";
    const error = failure(() => parseRemoteUrl(remote));
    expect(error.message).not.toContain("evil");
    expect(error.message).not.toContain("\n");
    const path = failure(() =>
      ownerAndName({ host: "github.com", path: "a/b/\nINJECT" })
    );
    expect(path.message).not.toContain("INJECT");
    expect(path.message).not.toContain("\n");
  });
});

describe("a glab that does not answer", () => {
  const REMOTE = "https://gitlab.example.com/group/project.git";
  const hung = (over: Partial<ForgeEnv> = {}): ForgeEnv => ({
    gitlabHosts: [],
    originOnPath: false,
    glabFailure: { kind: "timed-out", afterMs: 10_000 },
    ...over,
  });

  test("resolves to glab-timeout, names the timeout and the VPN, and does not say unknown-host", () => {
    const error = failure(() => resolveForge(REMOTE, hung()));
    expect(error.code).toBe("glab-timeout");
    expect(error.message).toContain("glab did not answer within 10 s");
    expect(error.message).toContain("VPN");
    expect(error.message).toContain("gitlab.example.com");
    expect(error.message).not.toContain("unknown-host");
    expect(error.message).not.toContain("not listed");
  });

  test("a host that glab did list still resolves, so a late timeout cannot hide a known host", () => {
    expect(
      resolveForge(REMOTE, hung({ gitlabHosts: ["gitlab.example.com"] })).kind
    ).toBe("gitlab");
  });

  test("github.com never reports a glab timeout", () => {
    expect(resolveForge("https://github.com/o/r", hung()).kind).toBe("github");
  });

  test("a fake glab that hangs gives glab-timeout through detectForgeEnv and resolveForge", async () => {
    await withFakeBins({ glab: "sleep 5" }, async () => {
      const forge = await detectForgeEnv("gitlab.example.com", {
        glabTimeoutMs: 300,
      });
      const error = failure(() => resolveForge(REMOTE, forge));
      expect(error.code).toBe("glab-timeout");
      expect(error.message).toContain("within 0.3 s");
    });
  });

  test("a glab that answers with no hosts is still unknown-host and names glab auth login", async () => {
    await withFakeBins({ glab: "exit 1" }, async () => {
      const forge = await detectForgeEnv("gitlab.example.com", {
        glabTimeoutMs: 5000,
      });
      expect(forge.glabFailure).toBeUndefined();
      const error = failure(() => resolveForge(REMOTE, forge));
      expect(error.code).toBe("unknown-host");
      expect(error.message).toContain(
        "glab auth login --hostname gitlab.example.com"
      );
    });
  });
});

describe("a glab that is not installed", () => {
  test("resolves to glab-not-installed and does not ask to log in to glab", async () => {
    await withFakeBins({}, async (dir) => {
      process.env.PATH = `${dir}:/usr/bin:/bin`;
      const forge = await detectForgeEnv("gitlab.example.com");
      expect(forge.glabFailure).toEqual({ kind: "not-installed" });
      const error = failure(() =>
        resolveForge("https://gitlab.example.com/group/project.git", forge)
      );
      expect(error.code).toBe("glab-not-installed");
      expect(error.message).toContain("glab is not installed");
      expect(error.message).not.toContain("glab auth login");
    });
  });
});

describe("the glab timeout default", () => {
  test("is at least 5 s", () => {
    expect(GLAB_TIMEOUT_MS).toBeGreaterThanOrEqual(5000);
  });

  test("lets a glab that needs 4.8 s list its hosts when no timeout is passed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-default-"));
    const saved = process.env.PATH;
    try {
      await writeFile(
        join(dir, "glab"),
        `#!/bin/sh\n[ "$1" = warm ] && exit 0\nsleep 4.8\nprintf 'gitlab.example.com\\n'\n`
      );
      await chmod(join(dir, "glab"), 0o755);
      await Bun.spawn([join(dir, "glab"), "warm"]).exited;
      process.env.PATH = `${dir}:${saved}`;
      const forge = await detectForgeEnv("gitlab.example.com");
      expect(forge.gitlabHosts).toEqual(["gitlab.example.com"]);
      expect(forge.glabFailure).toBeUndefined();
    } finally {
      process.env.PATH = saved;
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("currentBranch", () => {
  async function repo(run: (dir: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "forge-branch-"));
    try {
      Bun.spawnSync(["git", "init", "-q", "-b", "feature/x", dir]);
      Bun.spawnSync([
        "git",
        "-C",
        dir,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.invalid",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "base",
      ]);
      await run(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  test("names the branch, slash included", async () => {
    await repo(async (dir) => {
      expect(await currentBranch(dir)).toBe("feature/x");
    });
  });

  test("is null on a detached HEAD and outside a repository", async () => {
    await repo(async (dir) => {
      Bun.spawnSync(["git", "-C", dir, "checkout", "-q", "--detach"]);
      expect(await currentBranch(dir)).toBeNull();
    });
    const outside = await mkdtemp(join(tmpdir(), "forge-outside-"));
    try {
      expect(await currentBranch(outside)).toBeNull();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("checkoutForge", () => {
  const dirs: string[] = [];
  const checkout = async (remote: string | null): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "forge-checkout-"));
    dirs.push(dir);
    Bun.spawnSync(["git", "init", "-q", dir]);
    if (remote !== null)
      Bun.spawnSync(["git", "-C", dir, "remote", "add", "origin", remote]);
    return dir;
  };
  const cleanup = async (): Promise<void> => {
    for (const dir of dirs.splice(0))
      await rm(dir, { recursive: true, force: true });
  };
  const GLAB_RAN = 'touch "$(dirname "$0")/glab-ran"';
  const ran = (dir: string): Promise<boolean> =>
    readFile(join(dir, "glab-ran")).then(
      () => true,
      () => false
    );
  const reasonOf = async (remote: string, glabTimeoutMs?: number) => {
    const forge = await checkoutForge(await checkout(remote), {
      glabTimeoutMs,
    });
    if (forge.kind !== "github") throw new Error("expected gh");
    return forge.ifGhFails?.code;
  };

  test("a github.com origin, no origin, and an unreadable origin go to gh with no other reason and never run glab", async () => {
    await withFakeBins({ glab: GLAB_RAN }, async (bin) => {
      try {
        for (const remote of [
          "git@github.com:o/r.git",
          null,
          "/srv/git/local.git",
        ])
          expect(await checkoutForge(await checkout(remote))).toEqual({
            kind: "github",
            ifGhFails: null,
          });
        expect(await ran(bin)).toBe(false);
      } finally {
        await cleanup();
      }
    });
  });

  test("a host that glab lists gives its project with every group segment", async () => {
    await withFakeBins({ glab: "printf 'gitlab.example.com\\n'" }, async () => {
      try {
        expect(
          await checkoutForge(
            await checkout("git@gitlab.example.com:platform/tools/app.git")
          )
        ).toEqual({
          kind: "gitlab",
          project: { host: "gitlab.example.com", path: "platform/tools/app" },
        });
      } finally {
        await cleanup();
      }
    });
  });

  test("an SSH host alias and ssh.github.com go to gh as before GitLab support, keeping why they are not GitLab", async () => {
    await withFakeBins({ glab: "printf 'gitlab.example.com\\n'" }, async () => {
      try {
        for (const remote of [
          "git@github.com-work:o/r.git",
          "ssh://git@ssh.github.com:443/o/r.git",
        ])
          expect(await reasonOf(remote)).toBe("unknown-host");
      } finally {
        await cleanup();
      }
    });
  });

  test("a host that glab does not list keeps unknown-host, and a hung glab keeps glab-timeout, for when gh fails too", async () => {
    const remote = "https://gitlab.example.com/g/p.git";
    await withFakeBins({ glab: "printf 'gitlab.com\\n'" }, async () => {
      try {
        expect(await reasonOf(remote)).toBe("unknown-host");
      } finally {
        await cleanup();
      }
    });
    await withFakeBins({ glab: "sleep 5" }, async () => {
      try {
        expect(await reasonOf(remote, 300)).toBe("glab-timeout");
      } finally {
        await cleanup();
      }
    });
  });

  test("an origin CLI on PATH keeps unsupported-forge for a non-GitHub host and leaves a GitHub host alone", async () => {
    await withFakeBins({ origin: "exit 0", glab: GLAB_RAN }, async (bin) => {
      try {
        expect(await reasonOf("https://gitlab.example.com/g/p.git")).toBe(
          "unsupported-forge"
        );
        expect(
          await checkoutForge(await checkout("https://github.com/o/r"))
        ).toEqual({ kind: "github", ifGhFails: null });
        expect(await ran(bin)).toBe(false);
      } finally {
        await cleanup();
      }
    });
  });
});

describe("ghFoundNoRepository", () => {
  test("is true when gh knows no GitHub remote, has no login, or is not installed", () => {
    expect(
      ghFoundNoRepository(
        1,
        "none of the git remotes configured for this repository point to a known GitHub host. To tell gh about a new GitHub host, please use `gh auth login`"
      )
    ).toBe(true);
    expect(
      ghFoundNoRepository(
        4,
        "To get started with GitHub CLI, please run:  gh auth login"
      )
    ).toBe(true);
    expect(ghFoundNoRepository(127, "gh is not installed")).toBe(true);
  });

  test("is false once gh found the repository and failed on the pull request", () => {
    for (const line of [
      'no pull requests found for branch "topic"',
      "GraphQL: Could not resolve to a PullRequest with the number of 99. (repository.pullRequest)",
      "error connecting to api.github.com",
    ])
      expect(ghFoundNoRepository(1, line)).toBe(false);
  });
});
