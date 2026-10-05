import {
  ForgeError,
  currentBranch,
  isHostname,
  isProjectPath,
} from "../forge/forge.ts";
import type { WatchDeadline } from "./deadline.ts";
import {
  WatcherQueryError,
  commandExit,
  parsePullRequest,
  prNumberField,
  run,
  unresolvedThreads,
  type CommandResult,
  type ThreadCandidate,
} from "./github.ts";
import {
  object,
  oneOf,
  parseLandingRevision,
  text,
  type LandingRevision,
} from "./landing.ts";
import type * as T from "./types.ts";
import { nonEmpty } from "./types.ts";

export const MERGE_STATE_BY_STATUS = {
  mergeable: "CLEAN",
  conflict: "DIRTY",
  draft_status: "DRAFT",
  need_rebase: "BLOCKED",
  ci_must_pass: "BLOCKED",
  ci_still_running: "BLOCKED",
  discussions_not_resolved: "BLOCKED",
  not_approved: "BLOCKED",
  requested_changes: "BLOCKED",
  commits_status: "BLOCKED",
  not_open: "BLOCKED",
  merge_request_blocked: "BLOCKED",
  merge_time: "BLOCKED",
  jira_association_missing: "BLOCKED",
  status_checks_must_pass: "BLOCKED",
  security_policy_pipeline_check: "BLOCKED",
  security_policy_violations: "BLOCKED",
  locked_paths: "BLOCKED",
  locked_lfs_files: "BLOCKED",
  title_regex: "BLOCKED",
  checking: "UNKNOWN",
  unchecked: "UNKNOWN",
  preparing: "UNKNOWN",
  approvals_syncing: "UNKNOWN",
} as const satisfies Record<string, T.MergeStateStatus>;
export type DetailedMergeStatus = keyof typeof MERGE_STATE_BY_STATUS;
const DETAILED_MERGE_STATUSES = Object.keys(
  MERGE_STATE_BY_STATUS
) as readonly DetailedMergeStatus[];

export type DiscussionClass =
  | "open-thread"
  | "resolved-thread"
  | "plain-comment"
  | "system-note";
export type ThreadState = "open" | "resolved" | "not-a-thread";
export const THREAD_STATE_BY_CLASS = {
  "open-thread": "open",
  "resolved-thread": "resolved",
  "plain-comment": "not-a-thread",
  "system-note": "not-a-thread",
} as const satisfies Record<DiscussionClass, ThreadState>;

export type ApprovalSignal =
  | "changes-requested"
  | "approval-missing"
  | "approved"
  | "none";
export const DECISION_BY_SIGNAL = {
  "changes-requested": "CHANGES_REQUESTED",
  "approval-missing": "REVIEW_REQUIRED",
  approved: "APPROVED",
  none: null,
} as const satisfies Record<ApprovalSignal, T.ReviewDecision>;

type JobCheckKind = Exclude<T.Check["kind"], "code-review-gate">;
interface JobRow {
  readonly kind: JobCheckKind;
  readonly allowedToFail: JobCheckKind;
}
export const CHECK_BY_JOB_STATUS = {
  success: { kind: "passed", allowedToFail: "passed" },
  failed: { kind: "failed", allowedToFail: "skipped" },
  canceled: { kind: "failed", allowedToFail: "skipped" },
  canceling: { kind: "failed", allowedToFail: "pending" },
  skipped: { kind: "skipped", allowedToFail: "skipped" },
  manual: { kind: "pending", allowedToFail: "skipped" },
  created: { kind: "pending", allowedToFail: "pending" },
  pending: { kind: "pending", allowedToFail: "pending" },
  preparing: { kind: "pending", allowedToFail: "pending" },
  running: { kind: "pending", allowedToFail: "pending" },
  scheduled: { kind: "pending", allowedToFail: "pending" },
  waiting_for_resource: { kind: "pending", allowedToFail: "pending" },
  waiting_for_callback: { kind: "pending", allowedToFail: "pending" },
} as const satisfies Record<string, JobRow>;
export type JobStatus = keyof typeof CHECK_BY_JOB_STATUS;
const JOB_STATUSES = Object.keys(CHECK_BY_JOB_STATUS) as readonly JobStatus[];

export const ROLLUP_BY_PIPELINE_STATUS = {
  success: "SUCCESS",
  skipped: "SUCCESS",
  failed: "FAILURE",
  canceled: "FAILURE",
  canceling: "FAILURE",
  created: "PENDING",
  waiting_for_resource: "PENDING",
  waiting_for_callback: "PENDING",
  preparing: "PENDING",
  pending: "PENDING",
  running: "PENDING",
  scheduled: "PENDING",
  manual: "PENDING",
} as const satisfies Record<string, T.RollupState>;
export type PipelineStatus = keyof typeof ROLLUP_BY_PIPELINE_STATUS;
const PIPELINE_STATUSES = Object.keys(
  ROLLUP_BY_PIPELINE_STATUS
) as readonly PipelineStatus[];

const DISCUSSION_PAGE_LIMIT = 50;
const JOB_PAGE_LIMIT = 10;
const MERGE_REQUEST_PAGE_LIMIT = 3;
const PIPELINE_PAGE_LIMIT = 10;
const REVIEWER_PAGE_LIMIT = 10;
const PAGE_SIZE = 100;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function invalid(detail: string): never {
  throw new WatcherQueryError({ kind: "missing-key", retryable: true, detail });
}

function transient(detail: string): never {
  throw new WatcherQueryError({
    kind: "snapshot-changed",
    retryable: true,
    detail,
  });
}

function list(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) return invalid(`${label} must be a list`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    return invalid(`${label} must be a positive integer`);
  return value;
}

function optionalInteger(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    return invalid(`${label} must be an integer`);
  return value;
}

function rawText(value: unknown, label: string): string {
  if (typeof value !== "string") return invalid(`${label} must be a string`);
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") return invalid(`${label} must be a boolean`);
  return value;
}

function objectId(value: unknown, label: string): string {
  const id = text(value, label);
  if (!OBJECT_ID.test(id)) return invalid(`${label} must be a commit id`);
  return id;
}

function optionalText(value: unknown, label: string): string | null {
  return value === null || value === undefined ? null : text(value, label);
}

export interface HeadPipeline {
  readonly id: number;
  readonly status: PipelineStatus;
  readonly sha: string;
  readonly url: string;
}

interface MergeRequestBase {
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly draft: boolean;
  readonly mergedAt: string | null;
  readonly sha: string | null;
}
export interface OpenMergeRequest extends MergeRequestBase {
  readonly state: "OPEN";
  readonly sha: string;
  readonly status: DetailedMergeStatus;
  readonly hasConflicts: boolean;
  readonly headPipeline: HeadPipeline | null;
}
export type MergeRequest =
  | OpenMergeRequest
  | (MergeRequestBase & { readonly state: "CLOSED" | "MERGED" });

function parseHeadPipeline(value: unknown): HeadPipeline | null {
  if (value === undefined)
    throw unavailable(
      "pipelines-unreadable",
      "GitLab left head_pipeline out of the merge request, which it does when the glab token cannot read the project's pipelines, so the CI state is unknown. Give the token's user access to pipelines in this project."
    );
  if (value === null) return null;
  const pipeline = object(value, "head_pipeline");
  return {
    id: positiveInteger(pipeline.id, "head_pipeline.id"),
    status: oneOf(pipeline.status, PIPELINE_STATUSES, "head_pipeline.status"),
    sha: text(pipeline.sha, "head_pipeline.sha"),
    url: optionalText(pipeline.web_url, "head_pipeline.web_url") ?? "",
  };
}

export function parseSettledMergeRequest(value: unknown): MergeRequest {
  const mr = object(value, "merge request");
  const state = oneOf(
    mr.state,
    ["opened", "closed", "merged", "locked"] as const,
    "merge request.state"
  );
  if (state === "locked")
    return transient("GitLab has locked the merge request while it merges it");
  const base = {
    sourceBranch: text(mr.source_branch, "merge request.source_branch"),
    targetBranch: text(mr.target_branch, "merge request.target_branch"),
    draft: boolean(mr.draft, "merge request.draft"),
    mergedAt: optionalText(mr.merged_at, "merge request.merged_at"),
  };
  if (state !== "opened")
    return {
      ...base,
      state: state === "merged" ? "MERGED" : "CLOSED",
      sha: optionalText(mr.sha, "merge request.sha"),
    };
  const status = oneOf(
    mr.detailed_merge_status,
    DETAILED_MERGE_STATUSES,
    "merge request.detailed_merge_status"
  );
  if (MERGE_STATE_BY_STATUS[status] === "UNKNOWN")
    return transient(
      `GitLab has not finished computing the merge request (detailed_merge_status=${status})`
    );
  const sha = objectId(mr.sha, "merge request.sha");
  if (mr.diff_refs === null || mr.diff_refs === undefined)
    return transient("GitLab has not built the merge request diff yet");
  const refs = object(mr.diff_refs, "merge request.diff_refs");
  if (objectId(refs.head_sha, "diff_refs.head_sha") !== sha)
    return transient("GitLab has not built the diff for the newest commit yet");
  return {
    ...base,
    state: "OPEN",
    sha,
    status,
    hasConflicts: boolean(mr.has_conflicts, "merge request.has_conflicts"),
    headPipeline: parseHeadPipeline(mr.head_pipeline),
  };
}

export interface Approvals {
  readonly approved: boolean;
  readonly approvalsLeft: number | null;
  readonly changesRequested: boolean;
}

/** CE reports `approved` and `approved_by`. EE adds `approvals_left`. A reviewer's request for changes shows in `detailed_merge_status` only when the server blocks a merge on it, so the reviewers list is read too. */
export function parseApprovals(value: unknown, reviewers: unknown): Approvals {
  const approvals = object(value, "approvals");
  const approvedBy = list(approvals.approved_by, "approvals.approved_by");
  const left = optionalInteger(approvals.approvals_left, "approvals_left");
  return {
    approved:
      approvedBy.length > 0 &&
      (typeof approvals.approved === "boolean"
        ? approvals.approved
        : (left ?? 0) === 0),
    approvalsLeft: left,
    changesRequested: list(reviewers, "reviewers").some(
      (reviewer) => object(reviewer, "reviewer").state === "requested_changes"
    ),
  };
}

export function approvalSignal(
  status: DetailedMergeStatus,
  approvals: Approvals
): ApprovalSignal {
  if (status === "requested_changes" || approvals.changesRequested)
    return "changes-requested";
  if (status === "not_approved" || (approvals.approvalsLeft ?? 0) > 0)
    return "approval-missing";
  return approvals.approved ? "approved" : "none";
}

/** `targetTip` is the target branch's head commit, which GitHub's baseRefOid matches; diff_refs only moves when the source branch does. */
export function pullRequestFacts(
  mr: MergeRequest,
  approvals: Approvals,
  context: T.PrContext,
  targetTip: string | null
): T.PullRequestFacts {
  const open = mr.state === "OPEN";
  const facts = parsePullRequest(
    {
      mergeable: !open
        ? "UNKNOWN"
        : mr.status === "conflict" ||
            (mr.hasConflicts && mr.status !== "commits_status")
          ? "CONFLICTING"
          : "MERGEABLE",
      mergeStateStatus: open ? MERGE_STATE_BY_STATUS[mr.status] : "UNKNOWN",
      reviewDecision: open
        ? DECISION_BY_SIGNAL[approvalSignal(mr.status, approvals)]
        : null,
      headRefOid: mr.sha,
      baseRefOid: open ? targetTip : null,
      headRefName: mr.sourceBranch,
      baseRefName: mr.targetBranch,
      state: mr.state,
      mergedAt: mr.mergedAt,
      isDraft: mr.draft,
    },
    context
  );
  return open ? { ...facts, detailedMergeStatus: mr.status } : facts;
}

export function classifyDiscussion(value: unknown): DiscussionClass {
  const notes = list(object(value, "discussion").notes, "discussion.notes").map(
    (note) => object(note, "discussion note")
  );
  const resolvable = notes.filter(
    (note) => note.system !== true && note.resolvable === true
  );
  if (resolvable.length > 0)
    return resolvable.some((note) => note.resolved !== true)
      ? "open-thread"
      : "resolved-thread";
  return notes.length > 0 && notes.every((note) => note.system === true)
    ? "system-note"
    : "plain-comment";
}

function optionalObject(
  value: unknown,
  label: string
): Record<string, unknown> | null {
  return value === null || value === undefined ? null : object(value, label);
}

function firstComment(notes: readonly unknown[]): T.ReviewComment | null {
  if (notes.length === 0) return null;
  const note = object(notes[0], "discussion note");
  const author = optionalObject(note.author, "discussion note.author");
  const position = optionalObject(note.position, "discussion note.position");
  return {
    authorLogin:
      author === null ? null : optionalText(author.username, "author.username"),
    body: rawText(note.body, "discussion note.body"),
    path:
      position === null
        ? null
        : (optionalText(position.new_path, "position.new_path") ??
          optionalText(position.old_path, "position.old_path")),
    line:
      position === null
        ? null
        : (optionalInteger(position.new_line, "position.new_line") ??
          optionalInteger(position.old_line, "position.old_line")),
    createdAt: text(note.created_at, "discussion note.created_at"),
  };
}

export function parseDiscussions(
  values: readonly unknown[]
): readonly T.ReviewThread[] {
  const candidates: ThreadCandidate[] = [];
  for (const value of values) {
    const discussion = object(value, "discussion");
    const state = THREAD_STATE_BY_CLASS[classifyDiscussion(discussion)];
    if (state === "not-a-thread") continue;
    candidates.push({
      id: text(discussion.id, "discussion.id"),
      firstComment: firstComment(list(discussion.notes, "discussion.notes")),
      resolved: state === "resolved",
    });
  }
  return unresolvedThreads(candidates);
}

export interface Job {
  readonly name: string;
  readonly status: JobStatus;
  readonly allowFailure: boolean;
  readonly stage: string;
  readonly url: string;
  readonly failureReason: string | null;
}

export function parseJob(value: unknown): Job {
  const job = object(value, "job");
  return {
    name: text(job.name, "job.name"),
    status: oneOf(job.status, JOB_STATUSES, "job.status"),
    allowFailure: boolean(job.allow_failure, "job.allow_failure"),
    stage: optionalText(job.stage, "job.stage") ?? "",
    url: optionalText(job.web_url, "job.web_url") ?? "",
    failureReason: optionalText(job.failure_reason, "job.failure_reason"),
  };
}

export function checkFromJob(job: Job): T.Check {
  const row = CHECK_BY_JOB_STATUS[job.status];
  return {
    kind: job.allowFailure ? row.allowedToFail : row.kind,
    name: job.name,
    reportedState: job.status.toUpperCase(),
    description:
      job.failureReason ?? (job.allowFailure ? "allowed to fail" : ""),
    link: job.url,
    workflow: job.stage,
  };
}

export const rollupStateFor = (status: PipelineStatus): T.RollupState =>
  ROLLUP_BY_PIPELINE_STATUS[status];

function pipelineCheck(
  pipeline: HeadPipeline,
  kind: JobCheckKind,
  description: string
): T.Check {
  return {
    kind,
    name: "pipeline",
    reportedState: pipeline.status.toUpperCase(),
    description,
    link: pipeline.url,
    workflow: "",
  };
}

/** The jobs endpoint lists neither trigger jobs nor external commit statuses, and a config error has no job, so the pipeline status fills in what the list misses. */
export function checksForPipeline(
  jobs: readonly Job[],
  pipeline: HeadPipeline
): readonly T.Check[] {
  const checks = jobs.map(checkFromJob);
  const has = (kind: T.Check["kind"]): boolean =>
    checks.some((check) => check.kind === kind);
  const rollup = rollupStateFor(pipeline.status);
  if (rollup === "SUCCESS" && checks.length === 0)
    return [
      pipelineCheck(
        pipeline,
        pipeline.status === "skipped" ? "skipped" : "passed",
        "the pipeline lists no job"
      ),
    ];
  if (rollup === "FAILURE" && !has("failed"))
    return [
      ...checks,
      pipelineCheck(
        pipeline,
        "failed",
        "the pipeline failed with no failed job"
      ),
    ];
  if (rollup === "PENDING" && !has("failed") && !has("pending"))
    return [
      ...checks,
      pipelineCheck(pipeline, "pending", "the pipeline is not finished"),
    ];
  return checks;
}

function parseBody(stdout: string, endpoint: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new WatcherQueryError({
      kind: "json-parse",
      retryable: true,
      detail: `glab api ${endpoint}: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

function unavailable(code: string, detail: string): WatcherQueryError {
  return new WatcherQueryError({
    kind: "forge-unavailable",
    retryable: false,
    code,
    detail,
  });
}

function glabFailure(
  result: CommandResult,
  host: string,
  endpoint: string
): WatcherQueryError {
  const status = /\(HTTP (\d{3})\)/.exec(result.stderr)?.[1];
  if (status === "401" || /unauthenticated/i.test(result.stderr))
    return unavailable(
      "unauthenticated",
      `glab is not authenticated for ${host}. Run: glab auth login --hostname ${host}`
    );
  if (status === "403")
    return unavailable(
      "forbidden",
      `GitLab on ${host} refused access (HTTP 403). The glab token needs the api or read_api scope and access to the project.`
    );
  if (status === "404")
    return unavailable(
      "not-found",
      `GitLab on ${host} returned 404 for ${endpoint.split("?")[0]}. The project or merge request does not exist, or the token cannot see it.`
    );
  return commandExit(
    result,
    ["glab", "api", "--hostname", host, endpoint].join(" ")
  );
}

/** A merge request from a fork names a branch of another project. */
const fromTargetProject = (mr: Record<string, unknown>): boolean =>
  positiveInteger(mr.source_project_id, "merge request.source_project_id") ===
  positiveInteger(mr.target_project_id, "merge request.target_project_id");

export interface GlabReaderOptions {
  readonly cwd?: string;
  readonly exec?: (
    argv: readonly [string, ...string[]]
  ) => Promise<CommandResult>;
}

const readKey = (context: T.PrContext): string =>
  `${context.host}/${context.path}!${context.number}`;

export class GlabReader implements T.ForgeReader {
  readonly project: T.ProjectRef;
  private readonly reads = new Map<string, MergeRequest>();
  private readonly exec: (
    argv: readonly [string, ...string[]]
  ) => Promise<CommandResult>;
  private readonly cwd: string;

  constructor(
    project: T.ProjectRef,
    deadline: WatchDeadline,
    options: GlabReaderOptions = {}
  ) {
    if (!isHostname(project.host) || !isProjectPath(project.path))
      throw new ForgeError(
        "unparseable-remote",
        "the GitLab project is not a host and a group/project path"
      );
    this.project = { host: project.host.toLowerCase(), path: project.path };
    this.exec = options.exec ?? ((argv) => run(argv, deadline));
    this.cwd = options.cwd ?? process.cwd();
  }

  private projectUrl(project: T.ProjectRef): string {
    if (
      project.host.toLowerCase() !== this.project.host ||
      project.path.toLowerCase() !== this.project.path.toLowerCase()
    )
      throw new WatcherQueryError({
        kind: "invalid-context-url",
        retryable: false,
        rawValue: `${project.host}/${project.path}`,
        detail: `the merge request belongs to ${project.host}/${project.path}, not to ${this.project.host}/${this.project.path}, which glab was resolved for`,
      });
    return `projects/${encodeURIComponent(this.project.path)}`;
  }

  private mrUrl(context: T.PrContext, suffix = ""): string {
    return `${this.projectUrl(context)}/merge_requests/${context.number}${suffix}`;
  }

  private async api(endpoint: string): Promise<unknown> {
    const result = await this.exec([
      "glab",
      "api",
      "--hostname",
      this.project.host,
      endpoint,
    ]);
    if (result.code !== 0)
      throw glabFailure(result, this.project.host, endpoint);
    return parseBody(result.stdout, endpoint);
  }

  private async pages(
    endpoint: string,
    pageLimit: number
  ): Promise<readonly unknown[]> {
    const items: unknown[] = [];
    const separator = endpoint.includes("?") ? "&" : "?";
    const path = endpoint.split("?")[0];
    for (let page = 1; ; page++) {
      const batch = list(
        await this.api(
          `${endpoint}${separator}per_page=${PAGE_SIZE}&page=${page}`
        ),
        path
      );
      if (batch.length === 0) return items;
      if (page > pageLimit)
        throw unavailable(
          "too-many-items",
          `${path} has more than ${pageLimit * PAGE_SIZE} items, so a partial list is refused`
        );
      items.push(...batch);
      if (batch.length < PAGE_SIZE) return items;
    }
  }

  private async fetchMergeRequest(context: T.PrContext): Promise<MergeRequest> {
    return parseSettledMergeRequest(await this.api(this.mrUrl(context)));
  }

  private async lastRead(context: T.PrContext): Promise<MergeRequest> {
    return (
      this.reads.get(readKey(context)) ??
      (await this.fetchMergeRequest(context))
    );
  }

  async originRepo(): Promise<T.ProjectRef | null> {
    return this.project;
  }

  async currentPr(pr: T.PrNumber | null): Promise<T.PrContext> {
    if (pr !== null) return { ...this.project, number: pr };
    const branch = await currentBranch(this.cwd);
    if (branch === null)
      throw new WatcherQueryError({
        kind: "invalid-context-url",
        retryable: false,
        rawValue: "HEAD",
        detail:
          "the checkout has no branch checked out (a detached HEAD, or git could not read it), so there is no branch to find a merge request for; pass --pr",
      });
    const found = (
      await this.pages(
        `${this.projectUrl(this.project)}/merge_requests?state=opened&source_branch=${encodeURIComponent(branch)}`,
        MERGE_REQUEST_PAGE_LIMIT
      )
    )
      .map((item) => object(item, "merge request"))
      .filter(fromTargetProject);
    if (found.length !== 1)
      throw new WatcherQueryError({
        kind: "invalid-context-url",
        retryable: false,
        rawValue: branch,
        detail: `${found.length === 0 ? "no" : "more than one"} open merge request has the source branch ${JSON.stringify(branch)} in ${this.project.path}; pass --pr`,
      });
    return {
      ...this.project,
      number: prNumberField(found[0].iid, "merge request.iid"),
    };
  }

  async pullRequest(context: T.PrContext): Promise<T.PullRequestFacts> {
    const mrEndpoint = this.mrUrl(context);
    const approvalsEndpoint = this.mrUrl(context, "/approvals");
    const [mr, approvals] = await Promise.all([
      this.api(mrEndpoint).then(parseSettledMergeRequest),
      Promise.all([
        this.api(approvalsEndpoint),
        this.pages(this.mrUrl(context, "/reviewers"), REVIEWER_PAGE_LIMIT),
      ]).then(([approved, reviewers]) => parseApprovals(approved, reviewers)),
    ]);
    if (mr.state === "OPEN" && mr.headPipeline === null)
      await this.refuseUnlinkedHeadPipeline(context, mr);
    const targetTip =
      mr.state === "OPEN" ? await this.targetTip(context, mr) : null;
    this.reads.set(readKey(context), mr);
    return pullRequestFacts(mr, approvals, context, targetTip);
  }

  private async targetTip(
    context: T.PrContext,
    mr: OpenMergeRequest
  ): Promise<string> {
    const branch = object(
      await this.api(
        `${this.projectUrl(context)}/repository/branches/${encodeURIComponent(mr.targetBranch)}`
      ),
      "target branch"
    );
    return objectId(
      object(branch.commit, "target branch.commit").id,
      "target branch.commit.id"
    );
  }

  /** GitLab links a new pipeline to the merge request in a background job, so for a while the head pipeline reads null although it exists. */
  private async refuseUnlinkedHeadPipeline(
    context: T.PrContext,
    mr: OpenMergeRequest
  ): Promise<void> {
    const pipelines = await this.pages(
      this.mrUrl(context, "/pipelines"),
      PIPELINE_PAGE_LIMIT
    );
    if (
      pipelines.some(
        (pipeline) => object(pipeline, "merge request pipeline").sha === mr.sha
      )
    )
      transient(
        `GitLab lists a pipeline for the head commit ${mr.sha}, but the merge request does not show it as its head pipeline yet`
      );
  }

  async revision(context: T.PrContext): Promise<LandingRevision> {
    const mr = await this.fetchMergeRequest(context);
    if (mr.state !== "OPEN")
      return transient("the merge request is no longer open");
    return parseLandingRevision(
      {
        headRefOid: mr.sha,
        baseRefName: mr.targetBranch,
        baseRefOid: await this.targetTip(context, mr),
      },
      context
    );
  }

  async openPullRequests(
    repository: T.ProjectRef
  ): Promise<readonly T.OpenPullRequest[]> {
    const items = await this.pages(
      `${this.projectUrl(repository)}/merge_requests?state=opened`,
      MERGE_REQUEST_PAGE_LIMIT
    );
    return items.map((item, index) => {
      const mr = object(item, `open merge requests[${index}]`);
      return {
        number: prNumberField(mr.iid, `open merge requests[${index}].iid`),
        headRepository: fromTargetProject(mr) ? this.project : null,
        headRefName: text(mr.source_branch, "merge request.source_branch"),
        baseRefName: text(mr.target_branch, "merge request.target_branch"),
      };
    });
  }

  async checksFastPath(context: T.PrContext): Promise<T.ChecksFastPath> {
    const mr = await this.lastRead(context);
    if (
      mr.state !== "OPEN" ||
      mr.headPipeline === null ||
      mr.headPipeline.sha !== mr.sha
    )
      return { kind: "none-reported" };
    const jobs = (
      await this.pages(
        `${this.projectUrl(context)}/pipelines/${mr.headPipeline.id}/jobs`,
        JOB_PAGE_LIMIT
      )
    ).map(parseJob);
    const checks = checksForPipeline(jobs, mr.headPipeline);
    return nonEmpty(checks) === null
      ? { kind: "none-reported" }
      : { kind: "checks", checks, source: "glab-pipeline-jobs" };
  }

  async checkRollupPage(): Promise<T.RollupPage> {
    return { kind: "no-rollup" };
  }

  async reviewThreads(
    context: T.PrContext
  ): Promise<readonly T.ReviewThread[]> {
    return parseDiscussions(
      await this.pages(
        this.mrUrl(context, "/discussions"),
        DISCUSSION_PAGE_LIMIT
      )
    );
  }

  async commitRollups(
    context: T.PrContext
  ): Promise<readonly T.CommitRollup[]> {
    const mr = await this.lastRead(context);
    if (mr.state !== "OPEN" || mr.headPipeline === null)
      return mr.sha === null ? [] : [{ oid: mr.sha, state: null }];
    const reported = {
      oid: mr.headPipeline.sha,
      state: rollupStateFor(mr.headPipeline.status),
    };
    return reported.oid === mr.sha
      ? [reported]
      : [{ oid: mr.sha, state: null }, reported];
  }
}
