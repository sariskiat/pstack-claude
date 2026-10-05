import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForgeError } from "../forge/forge.ts";
import { WatchDeadline } from "./deadline.ts";
import {
  WatcherQueryError,
  discoverStack,
  type CommandResult,
} from "./github.ts";
import {
  HOST,
  PROJECT,
  context,
  failure,
  fixture,
  glabReader as reader,
  server,
  type Served,
} from "./gitlab.test-helper.ts";
import {
  CHECK_BY_JOB_STATUS,
  DECISION_BY_SIGNAL,
  GlabReader,
  MERGE_STATE_BY_STATUS,
  ROLLUP_BY_PIPELINE_STATUS,
  THREAD_STATE_BY_CLASS,
  approvalSignal,
  checkFromJob,
  checksForPipeline,
  classifyDiscussion,
  parseApprovals,
  parseDiscussions,
  parseJob,
  parseMergeRequest,
  pullRequestFacts,
  rollupStateFor,
  type ApprovalSignal,
  type Approvals,
  type DetailedMergeStatus,
  type DiscussionClass,
  type HeadPipeline,
  type JobStatus,
  type PipelineStatus,
} from "./gitlab.ts";
import { classifyPr, readSnapshot } from "./policy.ts";
import type * as T from "./types.ts";
import { parsePrNumber } from "./types.ts";

async function snapshot(served: Served, allowDraft = false) {
  const { reader: glab, calls } = reader(served);
  const row = await readSnapshot({
    reader: glab,
    context: context(served.mr?.iid ?? 0),
    pendingHistory: "include",
    allowDraft,
  });
  return { row, calls, decision: classifyPr(row, allowDraft) };
}

async function rejection(
  promise: Promise<unknown>
): Promise<WatcherQueryError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof WatcherQueryError) return error;
    throw error;
  }
  throw new Error("expected a WatcherQueryError");
}

const withStatus = (name: string, status: string) => ({
  ...fixture(name),
  detailed_merge_status: status,
});

describe("detailed_merge_status to MergeStateStatus", () => {
  const TABLE: readonly (readonly [DetailedMergeStatus, T.MergeStateStatus])[] =
    [
      ["mergeable", "CLEAN"],
      ["conflict", "DIRTY"],
      ["draft_status", "DRAFT"],
      ["need_rebase", "BLOCKED"],
      ["ci_must_pass", "BLOCKED"],
      ["ci_still_running", "BLOCKED"],
      ["discussions_not_resolved", "BLOCKED"],
      ["not_approved", "BLOCKED"],
      ["requested_changes", "BLOCKED"],
      ["commits_status", "BLOCKED"],
      ["not_open", "BLOCKED"],
      ["merge_request_blocked", "BLOCKED"],
      ["merge_time", "BLOCKED"],
      ["jira_association_missing", "BLOCKED"],
      ["status_checks_must_pass", "BLOCKED"],
      ["security_policy_pipeline_check", "BLOCKED"],
      ["security_policy_violations", "BLOCKED"],
      ["locked_paths", "BLOCKED"],
      ["locked_lfs_files", "BLOCKED"],
      ["title_regex", "BLOCKED"],
      ["checking", "UNKNOWN"],
      ["unchecked", "UNKNOWN"],
      ["preparing", "UNKNOWN"],
      ["approvals_syncing", "UNKNOWN"],
    ];
  const none: Approvals = {
    approved: false,
    approvalsLeft: null,
    changesRequested: false,
  };

  test.each(TABLE.filter(([, state]) => state !== "UNKNOWN"))(
    "%s is %s",
    (status, expected) => {
      const mr = parseMergeRequest(withStatus("mr-green.json", status));
      expect(pullRequestFacts(mr, none, context(1)).mergeStateStatus).toBe(
        expected
      );
    }
  );

  test.each(TABLE.filter(([, state]) => state === "UNKNOWN"))(
    "%s is UNKNOWN, so the reader refuses it and the poll retries",
    (status) => {
      expect(() =>
        parseMergeRequest(withStatus("mr-green.json", status))
      ).toThrow(/has not finished computing/);
      try {
        parseMergeRequest(withStatus("mr-green.json", status));
      } catch (error) {
        expect((error as WatcherQueryError).failure).toMatchObject({
          kind: "snapshot-changed",
          retryable: true,
        });
      }
    }
  );

  test("the table holds exactly the 24 values the 18.11 documentation lists", () => {
    expect(Object.keys(MERGE_STATE_BY_STATUS).sort()).toEqual(
      TABLE.map(([status]) => status).sort()
    );
    expect(TABLE).toHaveLength(24);
  });

  test("an unlisted value fails closed instead of reaching READY", () => {
    const error = (() => {
      try {
        parseMergeRequest(withStatus("mr-green.json", "brand_new_status"));
      } catch (caught) {
        return caught as WatcherQueryError;
      }
      throw new Error("expected a failure");
    })();
    expect(error.failure).toMatchObject({ kind: "missing-key" });
    expect(error.failure.detail).toContain("detailed_merge_status");
  });

  test("has_conflicts makes the merge request CONFLICTING even when another status comes first", () => {
    const mr = parseMergeRequest({
      ...withStatus("mr-green.json", "ci_must_pass"),
      has_conflicts: true,
    });
    expect(pullRequestFacts(mr, none, context(1))).toMatchObject({
      mergeable: "CONFLICTING",
      mergeStateStatus: "BLOCKED",
    });
  });

  test("a draft is a draft whatever the status says", () => {
    const mr = parseMergeRequest({
      ...withStatus("mr-green.json", "ci_must_pass"),
      draft: true,
    });
    expect(pullRequestFacts(mr, none, context(1)).isDraft).toBe(true);
  });

  test("opened, closed, and merged map to OPEN, CLOSED, and MERGED", () => {
    expect(
      pullRequestFacts(
        parseMergeRequest(fixture("mr-green.json")),
        none,
        context(1)
      ).state
    ).toBe("OPEN");
    expect(
      pullRequestFacts(
        parseMergeRequest(fixture("mr-closed.json")),
        none,
        context(10)
      ).state
    ).toBe("CLOSED");
    const merged = pullRequestFacts(
      parseMergeRequest(fixture("mr-merged.json")),
      none,
      context(8)
    );
    expect(merged.state).toBe("MERGED");
    expect(merged.mergedAt).not.toBeNull();
  });

  test("a locked merge request is a retryable error", () => {
    expect(() =>
      parseMergeRequest({ ...fixture("mr-green.json"), state: "locked" })
    ).toThrow(/locked/);
  });

  test("the head, base, and branch fields come from the merge request", () => {
    const facts = pullRequestFacts(
      parseMergeRequest(fixture("mr-green.json")),
      none,
      context(1)
    );
    const raw = fixture("mr-green.json");
    expect(facts).toMatchObject({
      headRefOid: raw.sha,
      baseRefOid: raw.diff_refs.base_sha,
      headRefName: "lane-green",
      baseRefName: "main",
    });
  });

  test("a diff that is not built, or built for an older commit, is a retryable error", () => {
    expect(() => parseMergeRequest(fixture("mr-preparing.json"))).toThrow(
      /preparing/
    );
    expect(() =>
      parseMergeRequest({ ...fixture("mr-green.json"), diff_refs: null })
    ).toThrow(/diff/);
    const raw = fixture("mr-green.json");
    expect(() =>
      parseMergeRequest({
        ...raw,
        diff_refs: { ...raw.diff_refs, head_sha: "a".repeat(40) },
      })
    ).toThrow(/diff for the newest commit/);
  });

  test("a commit id that is not hex never reaches the facts", () => {
    expect(() =>
      parseMergeRequest({ ...fixture("mr-green.json"), sha: "--upload-pack=x" })
    ).toThrow(/commit id/);
  });
});

describe("approvals to ReviewDecision", () => {
  const decision = (status: DetailedMergeStatus, approvals: Approvals) =>
    pullRequestFacts(
      parseMergeRequest(withStatus("mr-green.json", status)),
      approvals,
      context(1)
    ).reviewDecision;

  test("no approval on a server that has no approval rules is no decision", () => {
    expect(
      decision("mergeable", parseApprovals(fixture("approvals-green.json"), []))
    ).toBeNull();
  });

  test("one approval on the recorded Community Edition response is APPROVED", () => {
    expect(
      decision(
        "mergeable",
        parseApprovals(fixture("approvals-approved.json"), [])
      )
    ).toBe("APPROVED");
  });

  test("approvals still missing are REVIEW_REQUIRED (documented Enterprise shape, not recorded)", () => {
    const missing = parseApprovals(
      {
        approvals_required: 2,
        approvals_left: 1,
        approved_by: [
          { user: { username: "user" }, approved_at: "2026-01-01T00:00:00Z" },
        ],
      },
      []
    );
    expect(decision("mergeable", missing)).toBe("REVIEW_REQUIRED");
  });

  test("required approvals given are APPROVED without an approved flag", () => {
    const met = parseApprovals(
      {
        approvals_required: 2,
        approvals_left: 0,
        approved_by: [
          { user: { username: "user" } },
          { user: { username: "other" } },
        ],
      },
      []
    );
    expect(decision("mergeable", met)).toBe("APPROVED");
  });

  test("the not_approved status is REVIEW_REQUIRED even when the approvals read says approved", () => {
    expect(
      decision("not_approved", {
        approved: true,
        approvalsLeft: null,
        changesRequested: false,
      })
    ).toBe("REVIEW_REQUIRED");
  });

  test("the requested_changes status wins over an approval and a missing approval", () => {
    expect(
      decision("requested_changes", {
        approved: true,
        approvalsLeft: 0,
        changesRequested: false,
      })
    ).toBe("CHANGES_REQUESTED");
    expect(
      decision("requested_changes", {
        approved: false,
        approvalsLeft: 2,
        changesRequested: false,
      })
    ).toBe("CHANGES_REQUESTED");
  });

  test("the signal precedence is changes, missing, approved, none", () => {
    const signals: readonly (readonly [
      DetailedMergeStatus,
      Approvals,
      ApprovalSignal,
    ])[] = [
      [
        "requested_changes",
        { approved: true, approvalsLeft: 1, changesRequested: false },
        "changes-requested",
      ],
      [
        "mergeable",
        { approved: true, approvalsLeft: 0, changesRequested: true },
        "changes-requested",
      ],
      [
        "not_approved",
        { approved: true, approvalsLeft: 0, changesRequested: false },
        "approval-missing",
      ],
      [
        "mergeable",
        { approved: true, approvalsLeft: 1, changesRequested: false },
        "approval-missing",
      ],
      [
        "mergeable",
        { approved: true, approvalsLeft: 0, changesRequested: false },
        "approved",
      ],
      [
        "mergeable",
        { approved: false, approvalsLeft: null, changesRequested: false },
        "none",
      ],
    ];
    for (const [status, approvals, expected] of signals)
      expect(approvalSignal(status, approvals)).toBe(expected);
  });

  test("every signal has a row, and the rows are the four decisions", () => {
    expect(Object.entries(DECISION_BY_SIGNAL).sort()).toEqual([
      ["approval-missing", "REVIEW_REQUIRED"],
      ["approved", "APPROVED"],
      ["changes-requested", "CHANGES_REQUESTED"],
      ["none", null],
    ]);
  });

  test("a reviewer's request for changes is CHANGES_REQUESTED although the status says mergeable (recorded)", () => {
    const changes = parseApprovals(
      fixture("approvals-green.json"),
      fixture("reviewers-changes.json")
    );
    expect(changes.changesRequested).toBe(true);
    expect(decision("mergeable", changes)).toBe("CHANGES_REQUESTED");
    expect(decision("mergeable", { ...changes, approved: true })).toBe(
      "CHANGES_REQUESTED"
    );
  });

  test("reviewers who have not requested changes do not block", () => {
    const states = ["unreviewed", "review_started", "reviewed", "approved"];
    const approvals = fixture("approvals-green.json");
    expect(
      parseApprovals(
        approvals,
        states.map((state) => ({ user: { username: "user" }, state }))
      ).changesRequested
    ).toBe(false);
    expect(parseApprovals(approvals, []).changesRequested).toBe(false);
  });

  test("a reviewers response that is not a list is refused", () => {
    expect(() =>
      parseApprovals(fixture("approvals-green.json"), { message: "x" })
    ).toThrow(/reviewers/);
  });

  test("a response without approved_by is not an approvals response", () => {
    expect(() => parseApprovals({ approved: true }, [])).toThrow(/approved_by/);
  });
});

describe("discussions to ReviewThread", () => {
  const note = (over: Record<string, unknown> = {}) => ({
    id: 1,
    type: "DiscussionNote",
    body: "text",
    created_at: "2026-01-01T00:00:00Z",
    system: false,
    resolvable: true,
    resolved: false,
    author: { username: "user" },
    ...over,
  });
  const discussion = (notes: unknown[], id = "d1") => ({
    id,
    individual_note: false,
    notes,
  });

  const CLASSES: readonly (readonly [string, unknown[], DiscussionClass])[] = [
    ["an unresolved thread", [note()], "open-thread"],
    ["a resolved thread", [note({ resolved: true })], "resolved-thread"],
    [
      "a thread with one unresolved reply",
      [note({ resolved: true }), note({ resolved: false })],
      "open-thread",
    ],
    [
      "a plain comment",
      [note({ type: null, resolvable: false, resolved: undefined })],
      "plain-comment",
    ],
    [
      "a system note",
      [note({ system: true, resolvable: false })],
      "system-note",
    ],
    [
      "a system note that says resolvable",
      [note({ system: true, resolvable: true })],
      "system-note",
    ],
  ];

  test.each(CLASSES)("%s is %s", (_, notes, expected) => {
    expect(classifyDiscussion(discussion(notes))).toBe(expected);
  });

  test("every class has a row, and only the open class is an open thread", () => {
    expect(Object.entries(THREAD_STATE_BY_CLASS).sort()).toEqual([
      ["open-thread", "open"],
      ["plain-comment", "not-a-thread"],
      ["resolved-thread", "resolved"],
      ["system-note", "not-a-thread"],
    ]);
  });

  test("only an open thread becomes a ReviewThread", () => {
    const threads = parseDiscussions([
      discussion([note()], "open"),
      discussion([note({ resolved: true })], "resolved"),
      discussion([note({ type: null, resolvable: false })], "plain"),
      discussion([note({ system: true, resolvable: false })], "system"),
    ]);
    expect(threads.map((thread) => thread.id)).toEqual(["open"]);
  });

  test("the recorded discussions give the general thread and the diff thread, in order", () => {
    const threads = parseDiscussions(fixture("discussions-threads.json"));
    expect(threads).toHaveLength(2);
    expect(threads[0]).toMatchObject({
      id: "8325f18d20bddb8b124b5abc745324e9cda00fde",
      isBugbot: false,
      firstComment: {
        authorLogin: "user",
        body: "Please explain why this file exists.",
        path: null,
        line: null,
      },
    });
    expect(threads[1].firstComment).toMatchObject({
      path: "src/thread-note.txt",
      line: 1,
      body: "This line needs a trailing newline check.",
    });
  });

  test("a bot thread is marked with the same rule as the GitHub reader", () => {
    const threads = parseDiscussions([
      discussion(
        [note({ author: { username: "cursor-bugbot" }, body: "RUN_ID: abc" })],
        "a"
      ),
      discussion(
        [
          note({
            author: { username: "cursor-bugbot" },
            body: "RUN_ID: def",
            resolved: true,
          }),
        ],
        "b"
      ),
    ]);
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ isBugbot: true, bugbotReviewPasses: 2 });
  });

  test("a comment on a removed line reports the old path and line", () => {
    const [thread] = parseDiscussions([
      discussion([
        note({
          type: "DiffNote",
          position: {
            new_path: null,
            new_line: null,
            old_path: "old.txt",
            old_line: 7,
          },
        }),
      ]),
    ]);
    expect(thread.firstComment).toMatchObject({ path: "old.txt", line: 7 });
  });

  test("a discussion without notes is not an object the reader accepts", () => {
    expect(() => parseDiscussions([{ id: "x" }])).toThrow(/notes/);
  });
});

describe("pipeline jobs to Check", () => {
  const job = (status: string, allowFailure = false) =>
    parseJob({
      id: 1,
      name: "unit",
      stage: "test",
      status,
      allow_failure: allowFailure,
      failure_reason: status === "failed" ? "script_failure" : null,
      web_url: `https://${HOST}/${PROJECT}/-/jobs/1`,
    });
  type Kind = T.Check["kind"];
  const ROWS: readonly (readonly [JobStatus, Kind, Kind])[] = [
    ["success", "passed", "passed"],
    ["failed", "failed", "skipped"],
    ["canceled", "failed", "failed"],
    ["canceling", "failed", "failed"],
    ["skipped", "skipped", "skipped"],
    ["manual", "pending", "skipped"],
    ["created", "pending", "pending"],
    ["pending", "pending", "pending"],
    ["preparing", "pending", "pending"],
    ["running", "pending", "pending"],
    ["scheduled", "pending", "pending"],
    ["waiting_for_resource", "pending", "pending"],
    ["waiting_for_callback", "pending", "pending"],
  ];

  test.each(ROWS)(
    "%s is %s, and %s when the job may fail",
    (status, kind, allowed) => {
      expect(checkFromJob(job(status)).kind).toBe(kind);
      expect(checkFromJob(job(status, true)).kind).toBe(allowed);
    }
  );

  test("the job table holds exactly the 13 values the 18.11 documentation lists", () => {
    expect(Object.keys(CHECK_BY_JOB_STATUS).sort()).toEqual(
      ROWS.map(([status]) => status).sort()
    );
    expect(ROWS).toHaveLength(13);
  });

  test("an unlisted job status fails closed", () => {
    expect(() => job("brand_new_status")).toThrow(/job.status/);
  });

  test("a failed job carries its name, state, reason, link, and stage", () => {
    expect(checkFromJob(job("failed"))).toEqual({
      kind: "failed",
      name: "unit",
      reportedState: "FAILED",
      description: "script_failure",
      link: `https://${HOST}/${PROJECT}/-/jobs/1`,
      workflow: "test",
    });
  });

  const PIPELINES: readonly (readonly [PipelineStatus, T.RollupState])[] = [
    ["success", "SUCCESS"],
    ["skipped", "SUCCESS"],
    ["failed", "FAILURE"],
    ["canceled", "FAILURE"],
    ["canceling", "FAILURE"],
    ["created", "PENDING"],
    ["waiting_for_resource", "PENDING"],
    ["preparing", "PENDING"],
    ["pending", "PENDING"],
    ["running", "PENDING"],
    ["scheduled", "PENDING"],
    ["manual", "PENDING"],
  ];
  test("the pipeline table holds exactly the listed values", () => {
    expect(Object.keys(ROLLUP_BY_PIPELINE_STATUS).sort()).toEqual(
      PIPELINES.map(([status]) => status).sort()
    );
  });

  test.each(PIPELINES)("pipeline %s is %s", (status, rollup) => {
    expect(rollupStateFor(status)).toBe(rollup);
  });

  const pipeline = (status: PipelineStatus): HeadPipeline => ({
    id: 7,
    status,
    sha: "a".repeat(40),
    ref: "feature",
    url: `https://${HOST}/${PROJECT}/-/pipelines/7`,
  });

  test("a failed pipeline with no failed job adds one failed check, so a failed trigger job cannot read as clean", () => {
    const checks = checksForPipeline(
      [parseJob({ ...jobJson("success") })],
      pipeline("failed")
    );
    expect(checks.map((check) => [check.kind, check.name])).toEqual([
      ["passed", "unit"],
      ["failed", "pipeline"],
    ]);
  });

  test("an unfinished pipeline with no pending job adds one pending check", () => {
    const checks = checksForPipeline(
      [parseJob(jobJson("success"))],
      pipeline("running")
    );
    expect(checks.map((check) => check.kind)).toEqual(["passed", "pending"]);
  });

  test("a job list that agrees with its pipeline gets no extra check", () => {
    expect(
      checksForPipeline([parseJob(jobJson("failed"))], pipeline("failed"))
    ).toHaveLength(1);
    expect(
      checksForPipeline([parseJob(jobJson("running"))], pipeline("running"))
    ).toHaveLength(1);
    expect(
      checksForPipeline([parseJob(jobJson("success"))], pipeline("success"))
    ).toHaveLength(1);
  });

  function jobJson(status: string) {
    return {
      id: 1,
      name: "unit",
      stage: "test",
      status,
      allow_failure: false,
      web_url: `https://${HOST}/${PROJECT}/-/jobs/1`,
    };
  }
});

const SCENARIOS: readonly {
  readonly name: string;
  readonly served: Served;
  readonly allowDraft?: boolean;
  readonly expect: (result: Awaited<ReturnType<typeof snapshot>>) => void;
}[] = [
  {
    name: "a green merge request is READY",
    served: {
      mr: fixture("mr-green.json"),
      approvals: fixture("approvals-green.json"),
      jobs: fixture("jobs-green.json"),
    },
    expect: ({ decision, row }) => {
      expect(decision.kind).toBe("ready");
      expect(
        row.kind === "open" && row.ci.kind === "ci-clean" && row.ci.source
      ).toBe("glab-pipeline-jobs");
    },
  },
  {
    name: "an approved merge request is READY",
    served: {
      mr: fixture("mr-approved.json"),
      approvals: fixture("approvals-approved.json"),
      jobs: fixture("jobs-green.json"),
    },
    expect: ({ decision }) => {
      expect(decision).toMatchObject({
        kind: "ready",
        pr: { proof: { gate: { reviewDecision: "APPROVED" } } },
      });
    },
  },
  {
    name: "a failed job blocks with the job named",
    served: {
      mr: fixture("mr-red.json"),
      approvals: fixture("approvals-green.json"),
      jobs: fixture("jobs-red.json"),
    },
    expect: ({ decision }) => {
      expect(decision).toMatchObject({
        kind: "blocker",
        blocker: {
          kind: "failing-checks",
          ci: {
            failed: [
              {
                name: "fail-job",
                reportedState: "FAILED",
                description: "script_failure",
              },
            ],
          },
        },
      });
    },
  },
  {
    name: "a failed job under ci_must_pass still blocks as failing checks",
    served: {
      mr: fixture("mr-ci-must-pass.json"),
      approvals: fixture("approvals-green.json"),
      jobs: fixture("jobs-red.json"),
    },
    expect: ({ decision }) => {
      expect(decision).toMatchObject({
        kind: "blocker",
        blocker: { kind: "failing-checks" },
      });
    },
  },
  {
    name: "a running pipeline waits and names the running job",
    served: {
      mr: fixture("mr-running.json"),
      approvals: fixture("approvals-green.json"),
      jobs: fixture("jobs-running.json"),
    },
    expect: ({ decision }) => {
      expect(decision).toMatchObject({
        kind: "waiting",
        pending: [{ name: "pass-job" }],
      });
    },
  },
  {
    name: "a running pipeline under ci_still_running waits instead of blocking",
    served: {
      mr: fixture("mr-ci-still-running.json"),
      approvals: fixture("approvals-green.json"),
      jobs: fixture("jobs-running.json"),
    },
    expect: ({ decision }) => {
      expect(decision).toMatchObject({
        kind: "waiting",
        pending: [{ name: "pass-job" }],
      });
    },
  },
  {
    name: "an unresolved discussion blocks with the thread named",
    served: {
      mr: fixture("mr-threads.json"),
      approvals: fixture("approvals-green.json"),
      jobs: fixture("jobs-green.json"),
      discussions: fixture("discussions-threads.json"),
    },
    expect: ({ decision }) => {
      expect(decision).toMatchObject({
        kind: "blocker",
        blocker: {
          kind: "review-threads",
          threads: [
            { id: "8325f18d20bddb8b124b5abc745324e9cda00fde" },
            { id: "1f0ef6a79a627ae2d19b13e2871be8413a61ccc3" },
          ],
        },
      });
    },
  },
  {
    name: "discussions_not_resolved still reports the threads first",
    served: {
      mr: fixture("mr-discussions-blocking.json"),
      approvals: fixture("approvals-green.json"),
      jobs: fixture("jobs-green.json"),
      discussions: fixture("discussions-threads.json"),
    },
    expect: ({ decision }) => {
      expect(decision).toMatchObject({
        kind: "blocker",
        blocker: { kind: "review-threads" },
      });
    },
  },
  {
    name: "a conflict blocks as merge conflicts",
    served: {
      mr: fixture("mr-conflict.json"),
      approvals: fixture("approvals-green.json"),
      jobs: fixture("jobs-green.json"),
    },
    expect: ({ decision }) => {
      expect(decision).toMatchObject({
        kind: "blocker",
        blocker: {
          kind: "merge-conflicts",
          facts: { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" },
        },
      });
    },
  },
  {
    name: "a draft blocks at the merge gate",
    served: {
      mr: fixture("mr-draft.json"),
      approvals: fixture("approvals-green.json"),
      jobs: fixture("jobs-green.json"),
    },
    expect: ({ decision }) => {
      expect(decision).toMatchObject({
        kind: "blocker",
        blocker: { kind: "merge-gate", reason: "draft-pr" },
      });
    },
  },
  {
    name: "a draft is READY with allow-draft",
    served: {
      mr: fixture("mr-draft.json"),
      approvals: fixture("approvals-green.json"),
      jobs: fixture("jobs-green.json"),
    },
    allowDraft: true,
    expect: ({ decision }) => {
      expect(decision).toMatchObject({
        kind: "ready",
        pr: { proof: { gate: { draft: "draft-allowed" } } },
      });
    },
  },
  {
    name: "need_rebase blocks at the merge gate",
    served: {
      mr: fixture("mr-need-rebase.json"),
      approvals: fixture("approvals-green.json"),
      jobs: fixture("jobs-green.json"),
    },
    expect: ({ decision }) => {
      expect(decision).toMatchObject({
        kind: "blocker",
        blocker: { kind: "merge-gate", reason: "merge-blocked" },
      });
    },
  },
  {
    name: "merge_time blocks at the merge gate",
    served: {
      mr: fixture("mr-merge-time.json"),
      approvals: fixture("approvals-green.json"),
      jobs: fixture("jobs-green.json"),
    },
    expect: ({ decision }) => {
      expect(decision).toMatchObject({
        kind: "blocker",
        blocker: { kind: "merge-gate", reason: "merge-blocked" },
      });
    },
  },
  {
    name: "a merge request with no commits is CONFLICTING, because GitLab reports it as cannot_be_merged",
    served: {
      mr: fixture("mr-no-commits.json"),
      approvals: fixture("approvals-green.json"),
      jobs: fixture("jobs-green.json"),
    },
    expect: ({ decision }) => {
      expect(decision).toMatchObject({
        kind: "blocker",
        blocker: {
          kind: "merge-conflicts",
          facts: { mergeable: "CONFLICTING", mergeStateStatus: "BLOCKED" },
        },
      });
    },
  },
  {
    name: "commits_status alone blocks at the merge gate (has_conflicts patched to false, not recorded)",
    served: {
      mr: { ...fixture("mr-no-commits.json"), has_conflicts: false },
      approvals: fixture("approvals-green.json"),
      jobs: fixture("jobs-green.json"),
    },
    expect: ({ decision }) => {
      expect(decision).toMatchObject({
        kind: "blocker",
        blocker: { kind: "merge-gate", reason: "merge-blocked" },
      });
    },
  },
  {
    name: "a missing approval blocks as review required (documented Enterprise shape, not recorded)",
    served: {
      mr: withStatus("mr-green.json", "not_approved"),
      approvals: { approvals_required: 1, approvals_left: 1, approved_by: [] },
      jobs: fixture("jobs-green.json"),
    },
    expect: ({ decision }) => {
      expect(decision).toMatchObject({
        kind: "blocker",
        blocker: { kind: "merge-gate", reason: "review-required" },
      });
    },
  },
  {
    name: "a reviewer's request for changes blocks at the merge gate while GitLab still says mergeable (recorded)",
    served: {
      mr: fixture("mr-changes.json"),
      approvals: fixture("approvals-green.json"),
      reviewers: fixture("reviewers-changes.json"),
      jobs: fixture("jobs-green.json"),
    },
    expect: ({ decision }) => {
      expect(decision).toMatchObject({
        kind: "blocker",
        blocker: { kind: "merge-gate", reason: "changes-requested" },
      });
    },
  },
  {
    name: "requested changes block at the merge gate (status only, not recorded)",
    served: {
      mr: withStatus("mr-green.json", "requested_changes"),
      approvals: fixture("approvals-green.json"),
      jobs: fixture("jobs-green.json"),
    },
    expect: ({ decision }) => {
      expect(decision).toMatchObject({
        kind: "blocker",
        blocker: { kind: "merge-gate", reason: "changes-requested" },
      });
    },
  },
  {
    name: "a failed pipeline whose jobs all passed blocks, so a failed trigger job is not READY",
    served: {
      mr: {
        ...fixture("mr-green.json"),
        head_pipeline: {
          ...fixture("mr-green.json").head_pipeline,
          status: "failed",
        },
      },
      approvals: fixture("approvals-green.json"),
      jobs: fixture("jobs-green.json"),
    },
    expect: ({ decision }) => {
      expect(decision).toMatchObject({
        kind: "blocker",
        blocker: {
          kind: "failing-checks",
          ci: { failed: [{ name: "pipeline" }] },
        },
      });
    },
  },
  {
    name: "a merge request with no pipeline reports no checks",
    served: {
      mr: { ...fixture("mr-green.json"), head_pipeline: null },
      approvals: fixture("approvals-green.json"),
    },
    expect: ({ decision, row }) => {
      expect(row.kind === "open" && row.ci.kind).toBe("ci-none");
      expect(decision.kind).toBe("ready");
    },
  },
  {
    name: "a merged merge request is merged",
    served: {
      mr: fixture("mr-merged.json"),
      approvals: fixture("approvals-green.json"),
    },
    expect: ({ row }) => {
      expect(row.kind).toBe("merged");
    },
  },
  {
    name: "a closed merge request is closed",
    served: {
      mr: fixture("mr-closed.json"),
      approvals: fixture("approvals-green.json"),
    },
    expect: ({ row }) => {
      expect(row.kind).toBe("closed");
    },
  },
];

describe("recorded merge requests through the unchanged policy", () => {
  test.each(SCENARIOS.map((scenario) => [scenario.name, scenario] as const))(
    "%s",
    async (_, scenario) => {
      scenario.expect(
        await snapshot(scenario.served, scenario.allowDraft ?? false)
      );
    }
  );

  test("a merge request that GitLab is still preparing retries instead of reporting", async () => {
    const error = await rejection(
      snapshot({
        mr: fixture("mr-preparing.json"),
        approvals: fixture("approvals-green.json"),
      })
    );
    expect(error.failure).toMatchObject({
      kind: "snapshot-changed",
      retryable: true,
    });
  });

  test("a head pipeline for an older commit is not the head's, so the poll retries", async () => {
    const green = fixture("mr-green.json");
    const error = await rejection(
      snapshot({
        mr: {
          ...green,
          head_pipeline: { ...green.head_pipeline, sha: "b".repeat(40) },
        },
        approvals: fixture("approvals-green.json"),
        jobs: fixture("jobs-green.json"),
      })
    );
    expect(error.failure.detail).toContain("has reported checks");
    expect(error.failure.retryable).toBe(true);
  });

  test("a merged-results pipeline has its own sha and still counts as the head's", async () => {
    const green = fixture("mr-green.json");
    const { decision } = await snapshot({
      mr: {
        ...green,
        head_pipeline: {
          ...green.head_pipeline,
          sha: "c".repeat(40),
          ref: "refs/merge-requests/1/merge",
        },
      },
      approvals: fixture("approvals-green.json"),
      jobs: fixture("jobs-green.json"),
    });
    expect(decision.kind).toBe("ready");
  });

  test("one poll of an open merge request makes 6 glab calls, all of them reads of the same project", async () => {
    const { calls } = await snapshot(SCENARIOS[0].served);
    expect(calls).toHaveLength(6);
    expect(calls.map((argv) => argv[4].replace(/\?.*/, ""))).toEqual(
      expect.arrayContaining([
        "projects/group%2Fproject/merge_requests/1",
        "projects/group%2Fproject/merge_requests/1/approvals",
        "projects/group%2Fproject/merge_requests/1/reviewers",
        "projects/group%2Fproject/merge_requests/1/discussions",
        `projects/group%2Fproject/pipelines/${fixture("mr-green.json").head_pipeline.id}/jobs`,
      ])
    );
    expect(
      calls.filter(
        (argv) => argv[4] === "projects/group%2Fproject/merge_requests/1"
      )
    ).toHaveLength(2);
    for (const argv of calls)
      expect(argv.slice(0, 4)).toEqual(["glab", "api", "--hostname", HOST]);
  });
});

describe("commands never carry a value that was not checked", () => {
  const endpoints = (calls: string[][]): string[] =>
    calls.map((argv) => argv[4]);

  test("a nested group path is encoded as one path segment", async () => {
    const { reader: glab, calls } = reader(
      {
        mr: fixture("mr-green.json"),
        approvals: fixture("approvals-green.json"),
      },
      { host: HOST, path: "platform/tools/team/app" }
    );
    await glab.pullRequest(context(1, "platform/tools/team/app"));
    expect(endpoints(calls)).toEqual([
      "projects/platform%2Ftools%2Fteam%2Fapp/merge_requests/1",
      "projects/platform%2Ftools%2Fteam%2Fapp/merge_requests/1/approvals",
      "projects/platform%2Ftools%2Fteam%2Fapp/merge_requests/1/reviewers",
    ]);
  });

  test("a pipeline id that is not a positive integer is refused before any jobs call", async () => {
    const green = fixture("mr-green.json");
    for (const id of ["1/../../x", -1, 1.5, "7", null]) {
      const { reader: glab, calls } = reader({
        mr: { ...green, head_pipeline: { ...green.head_pipeline, id } },
        approvals: fixture("approvals-green.json"),
      });
      const error = await rejection(glab.pullRequest(context(1)));
      expect(error.failure.detail).toContain("head_pipeline.id");
      expect(
        endpoints(calls).some((endpoint) => endpoint.includes("/jobs"))
      ).toBe(false);
    }
  });

  test("a context for another host or project is refused before any glab call", async () => {
    const { reader: glab, calls } = reader({ mr: fixture("mr-green.json") });
    const other = { ...context(1), host: "gitlab.example.net" };
    const wrongProject = { ...context(1), path: "other/project" };
    for (const target of [other, wrongProject]) {
      const error = await rejection(glab.pullRequest(target));
      expect(error.failure).toMatchObject({
        kind: "invalid-context-url",
        retryable: false,
      });
    }
    expect(calls).toHaveLength(0);
  });

  test("a project that is not a host and a group/project path is refused when the reader is built", () => {
    for (const project of [
      { host: "-oProxyCommand=x", path: PROJECT },
      { host: HOST, path: "only-one" },
      { host: HOST, path: "a/--flag" },
    ])
      expect(
        () => new GlabReader(project, new WatchDeadline(0, () => 0))
      ).toThrow(ForgeError);
  });
});

describe("glab failures", () => {
  async function failing(result: CommandResult) {
    const glab = new GlabReader(
      { host: HOST, path: PROJECT },
      new WatchDeadline(0, () => 0),
      { exec: async () => result }
    );
    return rejection(glab.pullRequest(context(1)));
  }

  test("a 401 is final and names glab auth login for the host", async () => {
    const error = await failing(
      failure(1, "glab: 401 Unauthorized (HTTP 401)\n")
    );
    expect(error.failure).toMatchObject({
      kind: "forge-unavailable",
      code: "unauthenticated",
      retryable: false,
    });
    expect(error.failure.detail).toContain(
      `glab auth login --hostname ${HOST}`
    );
  });

  test("glab with no token is final and names glab auth login for the host", async () => {
    const error = await failing(
      failure(1, "\n   ERROR  \n\n  Unauthenticated.\n")
    );
    expect(error.failure).toMatchObject({
      kind: "forge-unavailable",
      code: "unauthenticated",
    });
    expect(error.failure.detail).toContain(
      `glab auth login --hostname ${HOST}`
    );
  });

  test("a 403 and a 404 are final and say what to check", async () => {
    const forbidden = await failing(
      failure(1, "glab: 403 Forbidden (HTTP 403)")
    );
    expect(forbidden.failure).toMatchObject({
      kind: "forge-unavailable",
      code: "forbidden",
      retryable: false,
    });
    const missing = await failing(failure(1, "glab: 404 Not found (HTTP 404)"));
    expect(missing.failure).toMatchObject({
      kind: "forge-unavailable",
      code: "not-found",
      retryable: false,
    });
    expect(missing.failure.detail).toContain(
      "projects/group%2Fproject/merge_requests/1"
    );
  });

  test("a 500, a rate limit, and a dead connection keep the retry path", async () => {
    for (const stderr of [
      "glab: 500 Internal Server Error (HTTP 500)",
      "glab: 429 Too Many Requests (HTTP 429)",
      "dial tcp: i/o timeout",
    ]) {
      const error = await failing(failure(1, stderr));
      expect(error.failure).toMatchObject({
        kind: "command-exit",
        retryable: true,
        code: 1,
      });
    }
  });

  test("a body that is not JSON is a retryable parse failure, not a crash", async () => {
    const error = await failing({ code: 0, stdout: "<html>", stderr: "" });
    expect(error.failure).toMatchObject({
      kind: "json-parse",
      retryable: true,
    });
  });

  test("no failure text carries the token or the raw response body", async () => {
    const secret = "glpat-s3cret";
    const error = await failing({
      code: 1,
      stdout: `{"token":"${secret}"}`,
      stderr: "glab: 500 boom (HTTP 500)",
    });
    expect(JSON.stringify(error.failure)).not.toContain(secret);
  });
});

describe("open merge requests and stacks", () => {
  const listed = (
    iid: number,
    source: string,
    target: string,
    sourceProject = 42
  ) => ({
    iid,
    source_branch: source,
    target_branch: target,
    source_project_id: sourceProject,
    target_project_id: 42,
  });

  test("a stack is ordered bottom to top by source and target branch", async () => {
    const { reader: glab } = reader({
      mrList: [
        listed(3, "c", "b"),
        listed(1, "a", "main"),
        listed(2, "b", "a"),
      ],
    });
    const stack = await discoverStack(glab, context(2));
    expect(stack.map((pr) => Number(pr.number))).toEqual([1, 2, 3]);
  });

  test("a merge request from a fork is not a local head", async () => {
    const { reader: glab } = reader({
      mrList: [listed(1, "a", "main"), listed(2, "a", "a", 99)],
    });
    const open = await glab.openPullRequests({ host: HOST, path: PROJECT });
    expect(open.map((pr) => pr.headRepository)).toEqual([
      { host: HOST, path: PROJECT },
      null,
    ]);
  });

  test("the list is read page by page and a full last page is refused", async () => {
    const page = (offset: number) =>
      Array.from({ length: 100 }, (_, n) =>
        listed(offset + n + 1, `b${offset + n}`, "main")
      );
    const { reader: glab, calls } = reader({
      mrList: [...page(0), ...page(100)].slice(0, 150),
    });
    expect(
      await glab.openPullRequests({ host: HOST, path: PROJECT })
    ).toHaveLength(150);
    expect(calls.map((argv) => /[?&]page=(\d+)/.exec(argv[4])?.[1])).toEqual([
      "1",
      "2",
    ]);
    const full = reader({
      mrList: [...page(0), ...page(100), ...page(200), ...page(300)],
    });
    const error = await rejection(
      full.reader.openPullRequests({ host: HOST, path: PROJECT })
    );
    expect(error.failure.detail).toContain("partial list is refused");
  });

  test("an explicit merge request number needs no glab call", async () => {
    const { reader: glab, calls } = reader({});
    expect(await glab.currentPr(parsePrNumber(7))).toEqual(context(7));
    expect(await glab.originRepo()).toEqual({ host: HOST, path: PROJECT });
    expect(calls).toHaveLength(0);
  });
});

describe("the merge request of the current branch", () => {
  function checkout(branch: string | null): string {
    const dir = mkdtempSync(join(tmpdir(), "gitlab-branch-"));
    execFileSync("git", ["init", "-q", dir]);
    execFileSync("git", [
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
    if (branch === null)
      execFileSync("git", ["-C", dir, "checkout", "-q", "--detach"]);
    else execFileSync("git", ["-C", dir, "checkout", "-q", "-b", branch]);
    return dir;
  }
  test("finds the one open merge request of a branch whose name has a slash", async () => {
    const dir = checkout("feature/x");
    try {
      const { exec, calls } = server({ mrList: [{ iid: 9 }] });
      const glab = new GlabReader(
        { host: HOST, path: PROJECT },
        new WatchDeadline(0, () => 0),
        { exec, cwd: dir }
      );
      expect(await glab.currentPr(null)).toEqual(context(9));
      expect(calls[0][4]).toBe(
        "projects/group%2Fproject/merge_requests?state=opened&source_branch=feature%2Fx&per_page=2"
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no open merge request, or two, names the branch and says to pass --pr", async () => {
    for (const mrList of [[], [{ iid: 1 }, { iid: 2 }]]) {
      const dir = checkout("topic");
      try {
        const { exec } = server({ mrList });
        const glab = new GlabReader(
          { host: HOST, path: PROJECT },
          new WatchDeadline(0, () => 0),
          { exec, cwd: dir }
        );
        const error = await rejection(glab.currentPr(null));
        expect(error.failure.detail).toContain('"topic"');
        expect(error.failure.detail).toContain("--pr");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test("a detached HEAD says to pass --pr and makes no glab call", async () => {
    const dir = checkout(null);
    try {
      const { exec, calls } = server({});
      const glab = new GlabReader(
        { host: HOST, path: PROJECT },
        new WatchDeadline(0, () => 0),
        { exec, cwd: dir }
      );
      const error = await rejection(glab.currentPr(null));
      expect(error.failure.detail).toContain("detached HEAD");
      expect(calls).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
