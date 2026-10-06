import { DeadlineExceeded } from "../watch-pr/deadline.ts";
import type {
  ForgeReader,
  OpenPullRequest,
  ProjectRef,
} from "../watch-pr/types.ts";
import { parsePrNumber } from "../watch-pr/types.ts";
import { UserError } from "./errors.ts";
import type { ReadRow, StackRow } from "./stack.ts";
import type { Frontier } from "./store.ts";

export type ForgeFactory = (repo: string) => Promise<ForgeReader>;

const FORGE_DEADLINE_SECONDS = 60;

/** The reader that watch-pr picks for the checkout. The imports wait until here because they need installed packages. */
export const defaultForge: ForgeFactory = async (repo) => {
  const { selectReader } = await import("../watch-pr/cli.ts");
  const { WatchDeadline } = await import("../watch-pr/deadline.ts");
  const deadline = new WatchDeadline(
    FORGE_DEADLINE_SECONDS,
    () => performance.now() / 1_000
  );
  const choice = await selectReader({ owner: null, repo: null }, deadline, {
    checkout: repo,
  });
  if (choice.whyNotGitLab !== null) {
    throw new UserError(choice.whyNotGitLab.message);
  }
  return choice.reader;
};

const sameProject = (left: ProjectRef | null, right: ProjectRef): boolean =>
  left !== null &&
  left.host.toLowerCase() === right.host.toLowerCase() &&
  left.path.toLowerCase() === right.path.toLowerCase();

async function readRow(
  row: StackRow,
  reader: ForgeReader,
  project: ProjectRef,
  open: readonly OpenPullRequest[],
  known: ReadonlyMap<string, number>
): Promise<ReadRow> {
  const matches = open.filter(
    (pr) =>
      pr.headRefName === row.branch && sameProject(pr.headRepository, project)
  );
  const [match] = matches;
  if (matches.length > 1) {
    throw new UserError(
      `${matches.length} open pull requests have the head branch ${row.branch}: ${matches.map((pr) => `#${pr.number}`).join(", ")}`
    );
  }
  if (match !== undefined) {
    return { ...row, pr: match.number, state: "OPEN", base: match.baseRefName };
  }
  const number = known.get(row.branch);
  if (number === undefined) {
    throw new UserError(
      `branch ${row.branch} has no open pull request, and the last frontier does not know its number; run orch frontier set while the pull request is open`
    );
  }
  const facts = await reader.pullRequest({
    ...project,
    number: parsePrNumber(number),
  });
  if (facts.headRefName !== row.branch) {
    throw new UserError(
      `pull request #${number} has the head branch ${facts.headRefName}, not ${row.branch}`
    );
  }
  return { ...row, pr: number, state: facts.state, base: facts.baseRefName };
}

function forgeFailure(error: unknown): UserError {
  if (error instanceof UserError) return error;
  if (error instanceof DeadlineExceeded) {
    return new UserError(
      `the forge did not answer within ${FORGE_DEADLINE_SECONDS} s; the network or the VPN is the likely cause`
    );
  }
  return new UserError(
    `the forge read failed: ${error instanceof Error ? error.message : String(error)}`
  );
}

/**
 * Open pull requests come from one list call. A branch with no open pull request keeps the number the previous frontier
 * recorded, because the reader cannot find a merged pull request by its branch.
 */
export async function readStackOnForge(args: {
  readonly forge: ForgeFactory;
  readonly repo: string;
  readonly rows: readonly StackRow[];
  readonly previous: Frontier;
}): Promise<readonly ReadRow[]> {
  const known = new Map(args.previous.prs.map((pr) => [pr.branches, pr.pr]));
  try {
    const reader = await args.forge(args.repo);
    const project = await reader.originRepo();
    if (project === null) {
      throw new UserError(
        "the repository has no origin remote, so its pull requests cannot be read"
      );
    }
    const open = await reader.openPullRequests(project);
    return await Promise.all(
      args.rows.map((row) => readRow(row, reader, project, open, known))
    );
  } catch (error) {
    throw forgeFailure(error);
  }
}
