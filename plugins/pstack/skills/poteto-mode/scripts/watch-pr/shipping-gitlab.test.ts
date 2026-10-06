import { describe, expect, it } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForgeError } from "../forge/forge.ts";
import { WatcherQueryError } from "./github.ts";
import {
  HOST,
  PROJECT,
  context,
  failure,
  fixture,
  ok,
} from "./gitlab.test-helper.ts";
import { cancelPending, inspectLanding } from "./shipping.ts";
import {
  GlabShippingService,
  glabApiJson,
  glabMergeArgv,
  parseEdition,
  resolveGlabProject,
  type GlabExec,
} from "./shipping-gitlab.ts";

const START = "c".repeat(40);
const TIP = "d".repeat(40);
const MOVED_TIP = "f".repeat(40);
const ID = 71441;
const mr = (name: string, overrides: Record<string, unknown> = {}) => ({
  ...fixture(name),
  id: ID,
  merge_when_pipeline_succeeds: false,
  ...overrides,
});
const openMr = (overrides: Record<string, unknown> = {}) =>
  mr("mr-green.json", overrides);
const HEAD = openMr().sha as string;
const NUMBER = openMr().iid as number;

const car = (id: number, mergeRequestId: number) => ({
  id,
  merge_request: { id: mergeRequestId, iid: 9, project_id: 42 },
  status: "idle",
  target_branch: "main",
});

interface World {
  mr: Record<string, unknown>;
  version: unknown;
  tip: string;
  cars: readonly unknown[] | null;
  cancel: (world: World) => void;
}

function world(overrides: Partial<World> = {}): World {
  return {
    mr: openMr(),
    version: { version: "18.11.12", enterprise: false },
    tip: TIP,
    cars: null,
    cancel: (w) => {
      w.mr = { ...w.mr, merge_when_pipeline_succeeds: false };
      w.cars = w.cars === null ? null : [];
    },
    ...overrides,
  };
}

function server(state: World) {
  const calls: string[][] = [];
  const exec: GlabExec = async (argv) => {
    calls.push([...argv]);
    const endpoint = argv[argv.length - 1];
    const [path, query = ""] = endpoint.split("?");
    const page = Number(/(?:^|&)page=(\d+)/.exec(query)?.[1] ?? "1");
    const perPage = Number(/(?:^|&)per_page=(\d+)/.exec(query)?.[1] ?? "20");
    if (path === "version") return ok(state.version);
    if (path.endsWith("/cancel_merge_when_pipeline_succeeds")) {
      state.cancel(state);
      return ok({ status: "success" });
    }
    if (/\/merge_requests\/\d+$/.test(path)) return ok(state.mr);
    if (path.includes("/repository/branches/"))
      return ok({ name: "main", commit: { id: state.tip } });
    if (path.endsWith("/merge_trains"))
      return state.cars === null
        ? failure(1, '{"error":"404 Not Found"}\nglab: HTTP 404')
        : ok(state.cars.slice((page - 1) * perPage, page * perPage));
    return failure(1, `glab: 404 Not found (HTTP 404) ${endpoint}`);
  };
  return { exec, calls, state };
}

const service = (state: World) => {
  const served = server(state);
  return {
    ...served,
    service: new GlabShippingService(
      { host: HOST, path: PROJECT },
      served.exec
    ),
  };
};

const endpoints = (calls: readonly string[][]) =>
  calls.map((argv) => argv[argv.length - 1].split("?")[0]);
const NUMBERED = context(NUMBER);
const PROJECT_URL = "projects/group%2Fproject";

async function failureOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof WatcherQueryError) return error.failure;
    throw error;
  }
  throw new Error("expected a WatcherQueryError");
}

describe("a GitLab merge request as a landing record", () => {
  it("an open one carries its head, target branch, the live tip of the target, and nothing pending or merged", async () => {
    const { service: ship, calls } = service(world());
    expect(await ship.inspect(NUMBERED)).toEqual({
      revision: {
        context: NUMBERED,
        headRefOid: HEAD,
        baseRefName: "main",
        baseRefOid: TIP,
      },
      pullRequestId: String(ID),
      state: "OPEN",
      pending: { autoMerge: false, queueEntryId: null },
      mergeCommitOid: null,
    });
    expect(
      calls.every(
        (argv) => argv.slice(0, 4).join(" ") === `glab api --hostname ${HOST}`
      )
    ).toBe(true);
    expect(endpoints(calls).sort()).toEqual(
      [
        `${PROJECT_URL}/merge_requests/${NUMBER}`,
        `${PROJECT_URL}/repository/branches/main`,
        "version",
      ].sort()
    );
  });

  it("takes the base from the live target tip, which moves, and not from diff_refs.base_sha, which does not", async () => {
    const state = world();
    const { service: ship } = service(state);
    const before = await ship.inspect(NUMBERED);
    state.tip = MOVED_TIP;
    const after = await ship.inspect(NUMBERED);
    expect(before.revision.baseRefOid).toBe(TIP);
    expect(after.revision.baseRefOid).toBe(MOVED_TIP);
    expect(openMr().diff_refs).not.toMatchObject({ base_sha: MOVED_TIP });
  });

  it("reads merge-when-pipeline-succeeds from the merge request", async () => {
    const { service: ship } = service(
      world({ mr: openMr({ merge_when_pipeline_succeeds: true }) })
    );
    expect((await ship.inspect(NUMBERED)).pending).toEqual({
      autoMerge: true,
      queueEntryId: null,
    });
  });

  it("a merged one carries its merge commit and the diff start as base, and does not ask for a target branch that may be gone", async () => {
    const merged = mr("mr-merged.json");
    const { service: ship, calls } = service(world({ mr: merged }));
    const record = await ship.inspect(context(merged.iid as number));
    expect(record).toMatchObject({
      state: "MERGED",
      mergeCommitOid: merged.merge_commit_sha,
      revision: {
        headRefOid: merged.sha,
        baseRefName: "main",
        baseRefOid: (merged.diff_refs as { start_sha: string }).start_sha,
      },
    });
    expect(
      endpoints(calls).some((e) => e.includes("/repository/branches/"))
    ).toBe(false);
  });

  it("a merged one whose merge commit GitLab does not report stays null, so the merge is unconfirmed", async () => {
    const { service: ship } = service(
      world({ mr: mr("mr-merged.json", { merge_commit_sha: null }) })
    );
    expect(
      (await ship.inspect(context(mr("mr-merged.json").iid as number)))
        .mergeCommitOid
    ).toBeNull();
  });

  it("a closed one reports no merge commit, even if the field holds one", async () => {
    const closed = mr("mr-closed.json", { merge_commit_sha: "e".repeat(40) });
    const { service: ship } = service(world({ mr: closed }));
    expect(await ship.inspect(context(closed.iid as number))).toMatchObject({
      state: "CLOSED",
      mergeCommitOid: null,
      revision: {
        baseRefOid: (closed.diff_refs as { start_sha: string }).start_sha,
      },
    });
  });

  it("refuses a merge request GitLab is merging right now", async () => {
    const { service: ship } = service(
      world({ mr: openMr({ state: "locked" }) })
    );
    expect(await failureOf(ship.inspect(NUMBERED))).toMatchObject({
      kind: "snapshot-changed",
      retryable: true,
    });
  });

  it("refuses a context for another project before any call", async () => {
    const { service: ship, calls } = service(world());
    expect(
      await failureOf(ship.inspect(context(NUMBER, "other/project")))
    ).toMatchObject({ kind: "invalid-context-url", retryable: false });
    expect(calls).toEqual([]);
  });

  it("refuses an answer for a different merge request", async () => {
    const { service: ship } = service(
      world({ mr: openMr({ iid: NUMBER + 1 }) })
    );
    expect((await failureOf(ship.inspect(NUMBERED))).detail).toContain(
      `!${NUMBER + 1} for !${NUMBER}`
    );
  });

  describe("a missing or malformed field is unavailable, never an absent request", () => {
    const without = (key: string) => {
      const { [key]: _, ...rest } = openMr();
      return rest;
    };
    for (const [name, overrides, detail] of [
      [
        "merge_when_pipeline_succeeds",
        without("merge_when_pipeline_succeeds"),
        "merge_when_pipeline_succeeds",
      ],
      [
        "a non-boolean merge_when_pipeline_succeeds",
        openMr({ merge_when_pipeline_succeeds: "false" }),
        "merge_when_pipeline_succeeds",
      ],
      ["id", without("id"), "merge request.id"],
      ["sha", openMr({ sha: null }), "merge request.sha"],
      ["an abbreviated sha", openMr({ sha: HEAD.slice(0, 10) }), "commit id"],
      ["target_branch", openMr({ target_branch: "" }), "target_branch"],
      [
        "an unknown state",
        openMr({ state: "reopened" }),
        "merge request.state",
      ],
      [
        "diff_refs of a merged one",
        mr("mr-merged.json", { diff_refs: null }),
        "no diff_refs",
      ],
      [
        "merge_commit_sha of a merged one",
        (() => {
          const { merge_commit_sha: _, ...rest } = mr("mr-merged.json");
          return rest;
        })(),
        "merge_commit_sha",
      ],
    ] as const)
      it(name, async () => {
        const iid = (overrides.iid ?? NUMBER) as number;
        const { service: ship } = service(world({ mr: overrides }));
        const result = await inspectLanding(ship, context(iid));
        expect(result.kind).toBe("unavailable");
        expect(JSON.stringify(result)).toContain(detail);
      });
  });
});

describe("merge trains", () => {
  const enterprise = { version: "18.11.12", enterprise: true };

  it("a Community Edition server has none, proven by its version and not by a 404, so no train is read", async () => {
    const { service: ship, calls } = service(world());
    expect((await ship.inspect(NUMBERED)).pending.queueEntryId).toBeNull();
    expect(endpoints(calls).some((e) => e.includes("merge_trains"))).toBe(
      false
    );
  });

  it("an Enterprise server lists the active cars and finds the one of this merge request", async () => {
    const { service: ship, calls } = service(
      world({
        version: enterprise,
        mr: openMr({ merge_when_pipeline_succeeds: true }),
        cars: [car(5, ID + 1), car(6, ID), car(7, ID + 2)],
      })
    );
    expect((await ship.inspect(NUMBERED)).pending).toEqual({
      autoMerge: true,
      queueEntryId: "6",
    });
    expect(calls.map((argv) => argv[argv.length - 1])).toContain(
      `${PROJECT_URL}/merge_trains?scope=active&per_page=100&page=1`
    );
  });

  it("an Enterprise server whose active cars belong to other merge requests reports none", async () => {
    const { service: ship } = service(
      world({ version: enterprise, cars: [car(5, ID + 1)] })
    );
    expect((await ship.inspect(NUMBERED)).pending.queueEntryId).toBeNull();
  });

  it("reads the second page of cars", async () => {
    const cars = Array.from({ length: 100 }, (_, n) => car(n + 1, 5000 + n));
    const { service: ship, calls } = service(
      world({ version: enterprise, cars: [...cars, car(101, ID)] })
    );
    expect((await ship.inspect(NUMBERED)).pending.queueEntryId).toBe("101");
    expect(
      calls
        .map((argv) => argv[argv.length - 1])
        .filter((e) => e.includes("merge_trains"))
        .map((e) => /[?&]page=(\d+)/.exec(e)?.[1])
    ).toEqual(["1", "2"]);
  });

  it("an Enterprise server that cannot list its trains is unavailable, not free of them", async () => {
    const { service: ship } = service(
      world({ version: enterprise, cars: null })
    );
    expect((await inspectLanding(ship, NUMBERED)).kind).toBe("unavailable");
  });

  it("a malformed car is unavailable, so it cannot hide ours", async () => {
    for (const bad of [
      { id: 1 },
      { ...car(2, ID), id: "2" },
      { ...car(2, ID), merge_request: { id: "x" } },
    ]) {
      const { service: ship } = service(
        world({ version: enterprise, cars: [bad, car(3, ID)] })
      );
      expect((await inspectLanding(ship, NUMBERED)).kind).toBe("unavailable");
    }
  });

  it("a version with no enterprise flag is unavailable", async () => {
    for (const version of [
      { version: "18.11.12" },
      { enterprise: "no" },
      null,
    ]) {
      const { service: ship } = service(world({ version }));
      expect((await inspectLanding(ship, NUMBERED)).kind).toBe("unavailable");
    }
    expect(() => parseEdition({ enterprise: true })).not.toThrow();
  });

  it("reads the version once for all later inspections", async () => {
    const { service: ship, calls } = service(world());
    await ship.inspect(NUMBERED);
    await ship.inspect(NUMBERED);
    expect(endpoints(calls).filter((e) => e === "version")).toHaveLength(1);
  });

  it("asks again after a failed version read", async () => {
    let first = true;
    const served = server(world());
    const flaky: GlabExec = async (argv) =>
      argv[argv.length - 1] === "version" && first
        ? ((first = false), failure(1, "glab: 500 boom (HTTP 500)"))
        : served.exec(argv);
    const ship = new GlabShippingService({ host: HOST, path: PROJECT }, flaky);
    expect((await inspectLanding(ship, NUMBERED)).kind).toBe("unavailable");
    expect((await inspectLanding(ship, NUMBERED)).kind).toBe("inspected");
  });
});

describe("cancelling what is pending", () => {
  const cancelUrl = `${PROJECT_URL}/merge_requests/${NUMBER}/cancel_merge_when_pipeline_succeeds`;
  const armed = () =>
    world({ mr: openMr({ merge_when_pipeline_succeeds: true }) });

  it("posts the cancel endpoint of the merge request it inspected", async () => {
    const { service: ship, calls } = service(armed());
    const record = await ship.inspect(NUMBERED);
    calls.length = 0;
    await ship.disableAutoMerge(record.pullRequestId);
    expect(calls).toEqual([
      ["glab", "api", "--hostname", HOST, "--method", "POST", cancelUrl],
    ]);
  });

  it("takes a merge request off a train through the same endpoint", async () => {
    const { service: ship, calls } = service(armed());
    const record = await ship.inspect(NUMBERED);
    calls.length = 0;
    await ship.dequeue(record.pullRequestId);
    expect(calls.map((argv) => argv[argv.length - 1])).toEqual([cancelUrl]);
  });

  it("does not touch a merge request it did not inspect", async () => {
    const { service: ship, calls } = service(armed());
    for (const id of [String(ID), "1", ""])
      expect(await failureOf(ship.disableAutoMerge(id))).toMatchObject({
        kind: "forge-unavailable",
        code: "not-inspected",
      });
    expect(calls).toEqual([]);
  });

  it("an error status in a 2xx answer is not a failure, because only the reading back decides", async () => {
    const state = world({
      mr: openMr(),
      cancel: () => undefined,
    });
    const served = server(state);
    const exec: GlabExec = async (argv) =>
      argv[argv.length - 1].endsWith("cancel_merge_when_pipeline_succeeds")
        ? ok({
            message: "Can't cancel the automatic merge",
            status: "error",
            http_status: 406,
          })
        : served.exec(argv);
    const ship = new GlabShippingService({ host: HOST, path: PROJECT }, exec);
    const record = await ship.inspect(NUMBERED);
    await expect(
      ship.disableAutoMerge(record.pullRequestId)
    ).resolves.toBeUndefined();
  });

  it("a failed request is not swallowed", async () => {
    const served = server(armed());
    const exec: GlabExec = async (argv) =>
      argv[argv.length - 1].endsWith("cancel_merge_when_pipeline_succeeds")
        ? failure(1, "glab: 403 Forbidden (HTTP 403)")
        : served.exec(argv);
    const ship = new GlabShippingService({ host: HOST, path: PROJECT }, exec);
    const record = await ship.inspect(NUMBERED);
    expect(
      await failureOf(ship.disableAutoMerge(record.pullRequestId))
    ).toMatchObject({
      kind: "forge-unavailable",
      code: "forbidden",
    });
  });

  it("cancelPending disarms an armed merge request and reads the disarmed state back", async () => {
    const { service: ship, calls } = service(armed());
    const expected = await ship.inspect(NUMBERED);
    expect(expected.pending.autoMerge).toBe(true);
    calls.length = 0;
    const result = await cancelPending(ship, expected);
    expect(result).toMatchObject({
      kind: "cancelled",
      record: { pending: { autoMerge: false, queueEntryId: null } },
    });
    expect(
      calls
        .filter((argv) => argv.includes("--method"))
        .map((argv) => argv[argv.length - 1])
    ).toEqual([cancelUrl]);
  });

  it("cancelPending reports still-pending when a 2xx cancelled nothing", async () => {
    const { service: ship } = service({ ...armed(), cancel: () => undefined });
    const expected = await ship.inspect(NUMBERED);
    expect(await cancelPending(ship, expected)).toMatchObject({
      kind: "still-pending",
      record: { pending: { autoMerge: true } },
    });
  });

  it("cancelPending refuses a base that moved since the record, and posts nothing", async () => {
    const state = armed();
    const { service: ship, calls } = service(state);
    const expected = await ship.inspect(NUMBERED);
    state.tip = MOVED_TIP;
    calls.length = 0;
    expect(await cancelPending(ship, expected)).toMatchObject({
      kind: "changed",
    });
    expect(calls.some((argv) => argv.includes("--method"))).toBe(false);
  });

  it("cancelPending removes an armed merge request from its train with one post when the cancel removes both", async () => {
    const state = world({
      version: { version: "18.11.12", enterprise: true },
      mr: openMr({ merge_when_pipeline_succeeds: true }),
      cars: [car(6, ID)],
    });
    const { service: ship, calls } = service(state);
    const expected = await ship.inspect(NUMBERED);
    expect(expected.pending.queueEntryId).toBe("6");
    calls.length = 0;
    expect(await cancelPending(ship, expected)).toMatchObject({
      kind: "cancelled",
      record: { pending: { autoMerge: false, queueEntryId: null } },
    });
    expect(calls.filter((argv) => argv.includes("--method"))).toHaveLength(1);
  });

  it("cancelPending posts again for a car the first cancel left, and reports it when it stays", async () => {
    const state = world({
      version: { version: "18.11.12", enterprise: true },
      mr: openMr({ merge_when_pipeline_succeeds: true }),
      cars: [car(6, ID)],
      cancel: (w) => {
        w.mr = { ...w.mr, merge_when_pipeline_succeeds: false };
      },
    });
    const { service: ship, calls } = service(state);
    const expected = await ship.inspect(NUMBERED);
    calls.length = 0;
    expect(await cancelPending(ship, expected)).toMatchObject({
      kind: "still-pending",
      record: { pending: { autoMerge: false, queueEntryId: "6" } },
    });
    expect(calls.filter((argv) => argv.includes("--method"))).toHaveLength(2);
  });
});

describe("a merge command", () => {
  const SHA = "a".repeat(40);
  const base = { context: context(7), headSha: SHA };

  it("carries the head sha, turns auto-merge off, and names the project by URL", () => {
    expect(glabMergeArgv(base)).toEqual([
      "glab",
      "mr",
      "merge",
      "7",
      "--repo",
      `https://${HOST}/${PROJECT}`,
      "--sha",
      SHA,
      "--auto-merge=false",
      "--yes",
    ]);
  });

  it("every variant carries both guards", () => {
    for (const variant of [
      base,
      { ...base, squash: true },
      { ...base, context: context(12, "platform/tools/app") },
      { ...base, headSha: "9".repeat(64) },
    ]) {
      const argv = glabMergeArgv(variant);
      expect(argv).toContain("--auto-merge=false");
      expect(argv[argv.indexOf("--sha") + 1]).toBe(variant.headSha);
    }
    expect(glabMergeArgv({ ...base, squash: true })).toContain("--squash");
    expect(glabMergeArgv(base)).not.toContain("--squash");
  });

  it("refuses to build a merge without a full head sha", () => {
    for (const headSha of [
      "",
      SHA.slice(0, 7),
      SHA.toUpperCase(),
      `${SHA}\n`,
      "main",
      "HEAD",
    ])
      expect(() => glabMergeArgv({ ...base, headSha })).toThrow(
        WatcherQueryError
      );
  });

  it("refuses a host or project path that is not one", () => {
    for (const bad of [
      { ...base, context: { ...context(7), host: "evil.example.com/x" } },
      { ...base, context: { ...context(7), host: "-evil.example.com" } },
      { ...base, context: context(7, "../x") },
      { ...base, context: context(7, "onlyone") },
    ])
      expect(() => glabMergeArgv(bad)).toThrow(WatcherQueryError);
  });
});

describe("glab api requests", () => {
  const record = (reply = ok({})) => {
    const argvs: string[][] = [];
    const exec: GlabExec = async (argv) => {
      argvs.push([...argv]);
      return reply;
    };
    return { exec, argvs };
  };

  it("sends a plain GET without a method, and a write with its method and string fields", async () => {
    const { exec, argvs } = record();
    await glabApiJson(exec, HOST, "version");
    await glabApiJson(exec, HOST, "projects/1/merge_requests/2/merge", {
      method: "PUT",
      fields: { sha: "a".repeat(40), auto_merge: "true" },
    });
    expect(argvs).toEqual([
      ["glab", "api", "--hostname", HOST, "version"],
      [
        "glab",
        "api",
        "--hostname",
        HOST,
        "--method",
        "PUT",
        "--raw-field",
        `sha=${"a".repeat(40)}`,
        "--raw-field",
        "auto_merge=true",
        "projects/1/merge_requests/2/merge",
      ],
    ]);
  });

  it("reads an empty body, as after a DELETE, as null and names an HTTP failure", async () => {
    expect(
      await glabApiJson(
        record({ code: 0, stdout: "\n", stderr: "" }).exec,
        HOST,
        "x",
        {
          method: "DELETE",
        }
      )
    ).toBeNull();
    expect(
      await failureOf(
        glabApiJson(
          record(failure(1, "glab: 404 Not found (HTTP 404)")).exec,
          HOST,
          "projects/a%2Fb/merge_requests/9"
        )
      )
    ).toMatchObject({ kind: "forge-unavailable", code: "not-found" });
  });
});

describe("the host of a merge request must be one glab is logged in to", () => {
  function withBins<T>(
    bins: Record<string, string>,
    run: () => Promise<T>
  ): Promise<T> {
    const root = mkdtempSync(join(tmpdir(), "ship-gitlab-"));
    const bin = join(root, "bin");
    mkdirSync(bin);
    for (const [name, body] of Object.entries(bins)) {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    }
    const saved = process.env.PATH;
    process.env.PATH = `${bin}:${saved}`;
    return run().finally(() => {
      process.env.PATH = saved;
      rmSync(root, { recursive: true, force: true });
    });
  }
  const project = { host: HOST, path: PROJECT };

  it("accepts a listed host and returns the project with a lowercase host", async () => {
    await withBins({ glab: `printf '${HOST}\\n  ok\\n'` }, async () => {
      expect(
        await resolveGlabProject({ host: HOST.toUpperCase(), path: PROJECT })
      ).toEqual(project);
    });
  });

  it("refuses a host glab does not list, and names the login", async () => {
    await withBins({ glab: "printf 'gitlab.com\\n'" }, async () => {
      const error = await resolveGlabProject(project).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ForgeError);
      expect((error as ForgeError).code).toBe("unknown-host");
      expect((error as ForgeError).message).toContain(
        `glab auth login --hostname ${HOST}`
      );
    });
  });

  it("names a glab that does not answer, and one that is missing", async () => {
    await withBins({ glab: "sleep 5" }, async () => {
      const error = await resolveGlabProject(project, {
        glabTimeoutMs: 200,
      }).catch((e: unknown) => e);
      expect((error as ForgeError).code).toBe("glab-timeout");
    });
    await withBins({}, async () => {
      const saved = process.env.PATH;
      process.env.PATH = "/usr/bin:/bin";
      try {
        const error = await resolveGlabProject(project).catch(
          (e: unknown) => e
        );
        expect((error as ForgeError).code).toBe("glab-not-installed");
      } finally {
        process.env.PATH = saved;
      }
    });
  });

  it("does not serve a repository that an origin CLI manages", async () => {
    await withBins(
      { origin: "exit 0", glab: `printf '${HOST}\\n'` },
      async () => {
        const error = await resolveGlabProject(project).catch(
          (e: unknown) => e
        );
        expect((error as ForgeError).code).toBe("unsupported-forge");
      }
    );
  });

  it("is a ForgeError and not a crash for a project that is not a host and a path", () => {
    expect(
      () =>
        new GlabShippingService({ host: "evil/x", path: PROJECT }, async () =>
          ok({})
        )
    ).toThrow(ForgeError);
    expect(
      () =>
        new GlabShippingService({ host: HOST, path: "../x" }, async () =>
          ok({})
        )
    ).toThrow(ForgeError);
  });
});
