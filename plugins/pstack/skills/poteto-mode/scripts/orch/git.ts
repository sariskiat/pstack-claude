import { spawnSync } from "node:child_process";
import { UserError } from "./errors.ts";
import { parseCommitSha, type BranchName, type CommitSha } from "./stack.ts";

export interface GitRun {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs git in a repository and reports the exit status instead of throwing on it. */
export function gitRun(
  repo: string,
  args: readonly string[],
  env: Readonly<Record<string, string>> = {}
): GitRun {
  const result = spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined) {
    throw new UserError(
      `git ${args.join(" ")} did not run: ${result.error.message}`
    );
  }
  return {
    status: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export function failure(args: readonly string[], run: GitRun): UserError {
  const detail = run.stderr.trim().split("\n")[0] || `exit ${run.status}`;
  return new UserError(`git ${args.join(" ")} failed: ${detail}`);
}

export function git(
  repo: string,
  args: readonly string[],
  env?: Readonly<Record<string, string>>
): string {
  const run = gitRun(repo, args, env);
  if (run.status !== 0) throw failure(args, run);
  return run.stdout.trim();
}

/** Exit 0 is true, exit 1 is false, and anything else is a failed command. */
export function gitTest(repo: string, args: readonly string[]): boolean {
  const run = gitRun(repo, args);
  if (run.status === 0) return true;
  if (run.status === 1) return false;
  throw failure(args, run);
}

/** The commit a ref names, or null when the ref does not exist. */
export function commitOf(repo: string, ref: string): CommitSha | null {
  const args = ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`];
  const run = gitRun(repo, args);
  if (run.status === 1) return null;
  if (run.status !== 0) throw failure(args, run);
  return parseCommitSha(run.stdout.trim(), `commit of ${ref}`);
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
