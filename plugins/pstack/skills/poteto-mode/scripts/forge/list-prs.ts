import {
  ForgeError,
  capture,
  gitlabProjectForCheckout,
  type ProjectRef,
} from "./forge.ts";

export interface ListedPr {
  readonly number: number;
  readonly state: "OPEN" | "MERGED" | "CLOSED";
  readonly headRefName: string;
  readonly headRefOid: string;
  readonly ref?: string;
}

const LIST_TIMEOUT_MS = 60_000;
const PAGE_SIZE = 100;
const PAGE_LIMIT = 10;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const GITHUB_LIST = [
  "gh",
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
] as const;

const STATE_BY_MERGE_REQUEST_STATE = new Map<string, ListedPr["state"]>([
  ["opened", "OPEN"],
  ["locked", "OPEN"],
  ["merged", "MERGED"],
  ["closed", "CLOSED"],
]);

function failed(
  result: { readonly code: number; readonly stderr: string },
  what: string
): never {
  const reason = result.stderr.trim().split(/\r?\n/, 1)[0]?.slice(0, 240);
  throw new Error(
    `${what} failed${reason ? `: ${reason}` : ` (exit ${result.code})`}`
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMergeRequest(value: unknown): ListedPr {
  const state = isRecord(value)
    ? STATE_BY_MERGE_REQUEST_STATE.get(String(value.state))
    : undefined;
  if (
    !isRecord(value) ||
    typeof value.iid !== "number" ||
    !Number.isSafeInteger(value.iid) ||
    value.iid <= 0 ||
    state === undefined ||
    typeof value.source_branch !== "string" ||
    value.source_branch === "" ||
    typeof value.sha !== "string" ||
    !OBJECT_ID.test(value.sha)
  )
    throw new Error(
      "a merge request in the GitLab list is not in the expected shape"
    );
  return {
    number: value.iid,
    state,
    headRefName: value.source_branch,
    headRefOid: value.sha,
    ref: `!${value.iid}`,
  };
}

async function gitlabMergeRequests(
  project: ProjectRef
): Promise<readonly ListedPr[]> {
  const endpoint = `projects/${encodeURIComponent(project.path)}/merge_requests?scope=created_by_me&state=all&order_by=updated_at`;
  const listed: ListedPr[] = [];
  for (let page = 1; page <= PAGE_LIMIT; page++) {
    const result = await capture(
      [
        "glab",
        "api",
        "--hostname",
        project.host,
        `${endpoint}&per_page=${PAGE_SIZE}&page=${page}`,
      ],
      LIST_TIMEOUT_MS
    );
    if (result.code !== 0) failed(result, "glab api");
    const batch: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(batch))
      throw new Error("the GitLab merge request list is not an array");
    listed.push(...batch.map(parseMergeRequest));
    if (batch.length < PAGE_SIZE) return listed;
  }
  throw new Error(
    `more than ${PAGE_LIMIT * PAGE_SIZE} merge requests, so a partial list is refused`
  );
}

export async function listOwnPullRequests(
  cwd: string,
  options: { readonly glabTimeoutMs?: number } = {}
): Promise<readonly ListedPr[]> {
  const project = await gitlabProjectForCheckout(cwd, options);
  if (project !== null) return gitlabMergeRequests(project);
  const result = await capture(GITHUB_LIST, LIST_TIMEOUT_MS, cwd);
  if (result.code !== 0) failed(result, "gh pr list");
  return JSON.parse(result.stdout) as readonly ListedPr[];
}

if (import.meta.main) {
  try {
    const list = await listOwnPullRequests(process.argv[2] ?? process.cwd());
    process.stdout.write(`${JSON.stringify(list)}\n`);
  } catch (error) {
    console.error(
      error instanceof ForgeError
        ? `ForgeError[${error.code}]: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error)
    );
    process.exit(1);
  }
}
