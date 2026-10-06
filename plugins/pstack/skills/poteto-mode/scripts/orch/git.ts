import { execFileSync } from "node:child_process";
import { UserError } from "./errors.ts";
import { parseCommitSha, type BranchName, type CommitSha } from "./stack.ts";

function failure(args: readonly string[], error: unknown): UserError {
  const stderr =
    error !== null && typeof error === "object" && "stderr" in error
      ? String(error.stderr)
      : "";
  const detail =
    stderr.trim().split("\n")[0] ||
    (error instanceof Error ? error.message : String(error));
  return new UserError(`git ${args.join(" ")} failed: ${detail}`);
}

export function git(repo: string, args: readonly string[]): string {
  try {
    return execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw failure(args, error);
  }
}

/** Exit 0 is true, exit 1 is false, and anything else is a failed command. */
export function gitTest(repo: string, args: readonly string[]): boolean {
  try {
    execFileSync("git", ["-C", repo, ...args], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    return true;
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "status" in error &&
      error.status === 1
    ) {
      return false;
    }
    throw failure(args, error);
  }
}

/** The commit a ref names, or null when the ref does not exist. */
export function commitOf(repo: string, ref: string): CommitSha | null {
  const args = ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`];
  return gitTest(repo, args)
    ? parseCommitSha(git(repo, args), `commit of ${ref}`)
    : null;
}

export function branchTip(repo: string, branch: BranchName): CommitSha {
  const tip = commitOf(repo, `refs/heads/${branch}`);
  if (tip === null) {
    throw new UserError(`branch ${branch} does not exist in ${repo}`);
  }
  return tip;
}

/** The tip of a branch: the local one, else the one on origin. */
export function branchOrOriginTip(repo: string, branch: BranchName): CommitSha {
  const tip =
    commitOf(repo, `refs/heads/${branch}`) ??
    commitOf(repo, `refs/remotes/origin/${branch}`);
  if (tip === null) {
    throw new UserError(
      `branch ${branch} exists neither locally nor on origin in ${repo}`
    );
  }
  return tip;
}

export function isAncestor(
  repo: string,
  ancestor: CommitSha,
  descendant: CommitSha
): boolean {
  return gitTest(repo, ["merge-base", "--is-ancestor", ancestor, descendant]);
}

export function mergeBase(
  repo: string,
  left: string,
  right: string
): CommitSha {
  return parseCommitSha(
    git(repo, ["merge-base", left, right]),
    `merge base of ${left} and ${right}`
  );
}
