import {
  ForgeError,
  capture,
  checkoutForge,
  ghFoundNoRepository,
  neitherForge,
  type ProjectRef,
} from "./forge.ts";

export interface ListedPr {
  readonly number: number;
  readonly state: "OPEN" | "MERGED" | "CLOSED";
  readonly headRefName: string;
  readonly headRefOid: string | null;
  readonly ref?: string;
}

export interface ListOptions {
  readonly glabTimeoutMs?: number;
  readonly warn?: (line: string) => void;
}

const LIST_TIMEOUT_MS = 60_000;
const PAGE_SIZE = 100;
const PAGE_LIMIT = 10;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
// Merged and closed PRs drop out of gh's default open-only listing.
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

const firstLine = (stderr: string): string =>
  stderr.trim().split(/\r?\n/, 1)[0]?.slice(0, 240) ?? "";

function failed(
  result: { readonly code: number; readonly stderr: string },
  what: string
): never {
  const reason = firstLine(result.stderr);
  throw new Error(
    `${what} failed${reason ? `: ${reason}` : ` (exit ${result.code})`}`
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A merged or closed merge request may have lost its sha, as the single merge request read in watch-pr allows. */
function parseMergeRequest(
  value: unknown
): ListedPr | { readonly skipped: string } {
  if (!isRecord(value)) return { skipped: "a list item that is not an object" };
  const iid = value.iid;
  if (typeof iid !== "number" || !Number.isSafeInteger(iid) || iid <= 0)
    return { skipped: "a merge request without a valid iid" };
  const state = STATE_BY_MERGE_REQUEST_STATE.get(String(value.state));
  const sha =
    typeof value.sha === "string" && OBJECT_ID.test(value.sha)
      ? value.sha
      : value.sha === null && state !== "OPEN"
        ? null
        : undefined;
  if (
    state === undefined ||
    typeof value.source_branch !== "string" ||
    value.source_branch === "" ||
    sha === undefined
  )
    return {
      skipped: `merge request !${iid}, which is not in the expected shape`,
    };
  return {
    number: iid,
    state,
    headRefName: value.source_branch,
    headRefOid: sha,
    ref: `!${iid}`,
  };
}

async function gitlabMergeRequests(
  project: ProjectRef,
  warn: (line: string) => void
): Promise<readonly ListedPr[]> {
  const endpoint = `projects/${encodeURIComponent(project.path)}/merge_requests?scope=created_by_me&state=all&order_by=updated_at`;
  const listed: ListedPr[] = [];
  for (let page = 1; ; page++) {
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
    if (batch.length === 0) return listed;
    if (page > PAGE_LIMIT) {
      warn(
        `warn: more than ${PAGE_LIMIT * PAGE_SIZE} merge requests; only the ${PAGE_LIMIT * PAGE_SIZE} most recently updated are listed`
      );
      return listed;
    }
    for (const item of batch) {
      const parsed = parseMergeRequest(item);
      if ("skipped" in parsed) warn(`warn: skipped ${parsed.skipped}`);
      else listed.push(parsed);
    }
    if (batch.length < PAGE_SIZE) return listed;
  }
}

export async function listOwnPullRequests(
  cwd: string,
  options: ListOptions = {}
): Promise<readonly ListedPr[]> {
  const forge = await checkoutForge(cwd, options);
  if (forge.kind === "gitlab")
    return gitlabMergeRequests(
      forge.project,
      options.warn ?? ((line) => process.stderr.write(`${line}\n`))
    );
  const result = await capture(GITHUB_LIST, LIST_TIMEOUT_MS, cwd);
  if (result.code !== 0) {
    const line = firstLine(result.stderr);
    if (forge.ifGhFails !== null && ghFoundNoRepository(result.code, line))
      throw neitherForge(forge.ifGhFails, result.code, line);
    failed(result, "gh pr list");
  }
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
