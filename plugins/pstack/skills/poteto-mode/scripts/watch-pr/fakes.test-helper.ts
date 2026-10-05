import type {
  Check,
  ChecksFastPath,
  CommitRollup,
  ForgeReader,
  OpenPullRequest,
  PrContext,
  PullRequestFacts,
  ProjectRef,
  ReviewThread,
  RollupPage,
} from "./types.ts";
import { parsePullRequest } from "./github.ts";
import { parsePrNumber } from "./types.ts";

export interface FakeReaderOptions {
  readonly facts?: Partial<Omit<PullRequestFacts, "context">>;
  readonly fastPath?: ChecksFastPath;
  readonly rollupPages?: readonly RollupPage[];
  readonly threads?: readonly ReviewThread[];
  readonly commitRollups?: readonly CommitRollup[];
  readonly openPullRequests?: readonly OpenPullRequest[];
  readonly origin?: ProjectRef | null;
  readonly current?: PrContext;
}

export function passingCheck(name = "ci"): Check {
  return {
    kind: "passed",
    name,
    reportedState: "SUCCESS",
    description: "",
    link: "",
    workflow: "",
  };
}

export function pendingCheck(name = "ci"): Check {
  return {
    kind: "pending",
    name,
    reportedState: "PENDING",
    description: "",
    link: "",
    workflow: "",
  };
}

export function failedCheck(name = "ci"): Check {
  return {
    kind: "failed",
    name,
    reportedState: "FAILURE",
    description: "",
    link: "",
    workflow: "",
  };
}

export function fakeReader(
  options: FakeReaderOptions = {}
): ForgeReader & { readonly calls: readonly string[] } {
  const calls: string[] = [];
  const context = options.current ?? {
    host: "github.com",
    path: "owner/repo",
    number: parsePrNumber(1),
  };
  const defaults: PullRequestFacts = {
    context,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    headRefOid: "head",
    baseRefOid: "base",
    headRefName: "feature",
    baseRefName: "main",
    state: "OPEN",
    mergedAt: null,
    isDraft: false,
  };
  let page = 0;
  return {
    calls,
    async originRepo() {
      calls.push("originRepo");
      return options.origin === undefined
        ? { host: "github.com", path: "owner/repo" }
        : options.origin;
    },
    async currentPr(pr) {
      calls.push("currentPr");
      return { ...context, number: pr ?? context.number };
    },
    async pullRequest(requested) {
      calls.push("pullRequest");
      return parsePullRequest({ ...defaults, ...options.facts }, requested);
    },
    async revision(requested) {
      calls.push("revision");
      return {
        context: requested,
        baseRefOid: options.facts?.baseRefOid ?? "base",
        headRefOid: options.facts?.headRefOid ?? "head",
        baseRefName: options.facts?.baseRefName ?? defaults.baseRefName,
      };
    },
    async openPullRequests() {
      calls.push("openPullRequests");
      return options.openPullRequests ?? [];
    },
    async checksFastPath() {
      calls.push("checksFastPath");
      return options.fastPath ?? { kind: "checks", checks: [passingCheck()] };
    },
    async checkRollupPage(_requested, after) {
      calls.push(`checkRollupPage:${after ?? "null"}`);
      return (
        options.rollupPages?.[page++] ?? {
          kind: "contexts",
          checks: [],
          endCursor: null,
        }
      );
    },
    async reviewThreads() {
      calls.push("reviewThreads");
      return options.threads ?? [];
    },
    async commitRollups() {
      calls.push("commitRollups");
      return options.commitRollups ?? [{ oid: "head", state: "SUCCESS" }];
    },
  };
}
