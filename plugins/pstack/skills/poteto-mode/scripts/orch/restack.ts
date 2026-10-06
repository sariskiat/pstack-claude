import { existsSync, rmSync } from "node:fs";
import { UserError } from "./errors.ts";
import { branchTip, commitOf, git, gitRun, isAncestor } from "./git.ts";
import type { BranchName, CommitSha, StackRow } from "./stack.ts";

export interface RestackInput {
  readonly repo: string;
  readonly scratch: string;
  readonly trunk: BranchName;
  readonly survivors: readonly [StackRow, ...StackRow[]];
  readonly builtOn: CommitSha;
}

export interface Restacked {
  readonly base: CommitSha;
  readonly rebased: boolean;
}

/** A survivor, its tip, and the commit its tip has to contain: the trunk tip, or the tip of the branch below. */
interface Placed {
  readonly row: StackRow;
  readonly tip: CommitSha;
  readonly below: CommitSha;
}

const QUIET = {
  GIT_EDITOR: "true",
  GIT_SEQUENCE_EDITOR: "true",
  GIT_TERMINAL_PROMPT: "0",
};

function place(
  repo: string,
  survivors: readonly StackRow[],
  base: CommitSha
): readonly Placed[] {
  let below = base;
  return survivors.map((row) => {
    const tip = branchTip(repo, row.branch);
    const placed = { row, tip, below };
    below = tip;
    return placed;
  });
}

const onTipBelow = (repo: string, placed: Placed): boolean =>
  isAncestor(repo, placed.below, placed.tip);

/** The scratch worktree belongs to orch, so whatever a killed run left in it can go. */
function clearScratch(repo: string, scratch: string): void {
  if (existsSync(scratch)) {
    gitRun(repo, ["worktree", "remove", "--force", scratch]);
    rmSync(scratch, { recursive: true, force: true });
  }
  gitRun(repo, ["worktree", "prune"]);
}

function checkedOut(repo: string): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  let path = "";
  const lines = git(repo, ["worktree", "list", "--porcelain"]).split("\n");
  for (const line of lines) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    if (line.startsWith("branch refs/heads/")) {
      result.set(line.slice("branch refs/heads/".length), path);
    }
  }
  return result;
}

/** Local branches outside the stack that point into the commits the rebase rewrites. */
function strays(
  repo: string,
  recorded: CommitSha,
  top: CommitSha,
  stack: ReadonlySet<string>
): readonly string[] {
  const range = new Set(
    git(repo, ["rev-list", `${recorded}..${top}`]).split("\n")
  );
  const heads = git(repo, [
    "for-each-ref",
    "--format=%(objectname) %(refname:strip=2)",
    "refs/heads/",
  ]);
  return heads.split("\n").flatMap((line) => {
    const [object = "", name = ""] = line.split(" ");
    return range.has(object) && !stack.has(name) ? [name] : [];
  });
}

/**
 * Puts the first survivor on the trunk tip and every other one on the tip of the branch below it. Git moves the refs
 * only when it finishes the rebase, so a run that stops earlier changes no branch, and a run that finds them in place
 * rebases nothing.
 */
export function restackBranches(input: RestackInput): Restacked {
  const { repo, scratch, trunk, survivors, builtOn } = input;
  clearScratch(repo, scratch);
  const remoteTrunk = `refs/remotes/origin/${trunk}`;
  git(repo, [
    "fetch",
    "--quiet",
    "origin",
    `+refs/heads/${trunk}:${remoteTrunk}`,
  ]);
  const base = commitOf(repo, remoteTrunk);
  if (base === null) {
    throw new UserError(`origin/${trunk} does not exist after the fetch`);
  }
  if (base === builtOn) {
    throw new UserError(
      `origin/${trunk} is still at ${builtOn}, the commit the stack was built on, so the merge is not on it yet`
    );
  }
  if (!isAncestor(repo, builtOn, base)) {
    throw new UserError(
      `origin/${trunk} does not contain ${builtOn}, the commit the stack was built on; the trunk was rewritten`
    );
  }

  const placed = place(repo, survivors, base);
  const lowest = placed.find((item) => !onTipBelow(repo, item));
  if (lowest === undefined) return { base, rebased: false };

  const above = placed.slice(placed.indexOf(lowest) + 1);
  const recorded = lowest.row.parentTip;
  if (!isAncestor(repo, recorded, lowest.tip)) {
    throw new UserError(
      `parent tip ${recorded} of ${lowest.row.branch} is not in its history; stack.tsv is out of date`
    );
  }
  const offBelow = above.find((item) => !onTipBelow(repo, item));
  if (offBelow !== undefined) {
    throw new UserError(
      `${offBelow.row.branch} is not built on the tip of the branch below it; rebase it onto that tip first`
    );
  }
  const worktrees = checkedOut(repo);
  for (const { row } of [lowest, ...above]) {
    const path = worktrees.get(row.branch);
    if (path !== undefined) {
      throw new UserError(
        `branch ${row.branch} is checked out at ${path}; check out another branch there first`
      );
    }
  }
  const top = above[above.length - 1] ?? lowest;
  const extra = strays(
    repo,
    recorded,
    top.tip,
    new Set(survivors.map((row) => row.branch))
  );
  if (extra.length > 0) {
    throw new UserError(
      `${extra.join(", ")} also points into the commits that the restack rewrites; delete it or move it first`
    );
  }

  git(repo, ["worktree", "add", "--detach", "--quiet", scratch, top.tip]);
  const run = gitRun(
    scratch,
    [
      "rebase",
      "--update-refs",
      "--onto",
      lowest.below,
      recorded,
      top.row.branch,
    ],
    QUIET
  );
  if (run.status !== 0) {
    const conflicts = gitRun(scratch, [
      "diff",
      "--name-only",
      "--diff-filter=U",
    ])
      .stdout.split("\n")
      .filter((line) => line.length > 0);
    clearScratch(repo, scratch);
    throw new UserError(
      conflicts.length > 0
        ? `the rebase stopped with a conflict in ${conflicts.join(", ")}; no branch was changed`
        : `git rebase failed: ${run.stderr.trim().split("\n")[0]}; no branch was changed`
    );
  }
  clearScratch(repo, scratch);

  const left = place(repo, survivors, base).find(
    (item) => !onTipBelow(repo, item)
  );
  if (left !== undefined) {
    throw new UserError(
      `after the rebase ${left.row.branch} is not on the tip below it; run orch restack again after fixing that branch`
    );
  }
  return { base, rebased: true };
}
