import { UserError } from "./errors.ts";
import type { FrontierPrState } from "./store.ts";

declare const branchBrand: unique symbol;
export type BranchName = string & { readonly [branchBrand]: "BranchName" };
declare const shaBrand: unique symbol;
export type CommitSha = string & { readonly [shaBrand]: "CommitSha" };

/** One branch of the stack and the commit of its parent that it was built on. */
export interface StackRow {
  readonly branch: BranchName;
  readonly parent: BranchName;
  readonly parentTip: CommitSha;
}

/** A stack row with what the forge says about its pull request. */
export interface ReadRow extends StackRow {
  readonly pr: number;
  readonly state: FrontierPrState;
  readonly base: string;
}

export type RestackPlan =
  | { readonly kind: "nothing" }
  | { readonly kind: "drop-all"; readonly landed: readonly ReadRow[] }
  | {
      readonly kind: "rebase";
      readonly landed: readonly ReadRow[];
      readonly survivors: readonly [ReadRow, ...ReadRow[]];
      readonly trunk: BranchName;
    };

export const STACK_HEADER = "branch\tparent\tparent_tip";

const BRANCH_NAME = /^[A-Za-z0-9_][A-Za-z0-9._/+=@#,%-]*$/;
const COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** A subset of git's ref rules that also keeps a name out of options, TSV cells, and spreadsheet formulas. */
export function parseBranchName(value: string, label: string): BranchName {
  const components = value.split("/");
  const valid =
    BRANCH_NAME.test(value) &&
    !value.includes("..") &&
    !value.includes("//") &&
    !value.includes("@{") &&
    !/[./]$/.test(value) &&
    !components.some(
      (component) => component.startsWith(".") || component.endsWith(".lock")
    );
  if (!valid) {
    throw new UserError(
      `${label} ${JSON.stringify(value)} is not a branch name orch accepts: it starts with a letter, digit, or underscore and holds letters, digits, and . _ / + = @ # , % - only`
    );
  }
  return value as BranchName;
}

export function parseCommitSha(value: string, label: string): CommitSha {
  const lower = value.toLowerCase();
  if (!COMMIT_SHA.test(lower)) {
    throw new UserError(
      `${label} ${JSON.stringify(value)} is not a full commit SHA`
    );
  }
  return lower as CommitSha;
}

/** The stack is one chain: no duplicate branch, each parent is the row below, and the bottom parent is outside the stack. */
function assertChain(rows: readonly StackRow[]): void {
  const branches = new Set<string>();
  for (const [index, row] of rows.entries()) {
    if (branches.has(row.branch)) {
      throw new UserError(`stack.tsv lists branch ${row.branch} twice`);
    }
    branches.add(row.branch);
    if (row.parent === row.branch) {
      throw new UserError(
        `stack.tsv row ${index + 1}: ${row.branch} is its own parent`
      );
    }
    const below = rows[index - 1];
    if (below !== undefined && row.parent !== below.branch) {
      throw new UserError(
        `stack.tsv row ${index + 1}: parent of ${row.branch} is ${row.parent}, but the row below is ${below.branch}; the stack must be one chain`
      );
    }
  }
  const bottom = rows[0];
  if (bottom !== undefined && branches.has(bottom.parent)) {
    throw new UserError(
      `stack.tsv row 1: parent of ${bottom.branch} is ${bottom.parent}, which is a branch above it`
    );
  }
}

export function parseStack(
  cells: readonly (readonly string[])[]
): readonly StackRow[] {
  const rows = cells.map((row, index) => {
    const label = `stack.tsv row ${index + 1}`;
    return {
      branch: parseBranchName(row[0] ?? "", `${label} branch`),
      parent: parseBranchName(row[1] ?? "", `${label} parent`),
      parentTip: parseCommitSha(row[2] ?? "", `${label} parent_tip`),
    };
  });
  assertChain(rows);
  return rows;
}

export function stackCells(row: StackRow): readonly string[] {
  return [row.branch, row.parent, row.parentTip];
}

export function appendRow(
  rows: readonly StackRow[],
  row: StackRow
): readonly StackRow[] {
  const next = [...rows, row];
  assertChain(next);
  return next;
}

/** Only an end row can leave: dropping a middle row would leave its child with no parent. */
export function dropRow(
  rows: readonly StackRow[],
  branch: BranchName
): { readonly dropped: StackRow; readonly kept: readonly StackRow[] } {
  const index = rows.findIndex((row) => row.branch === branch);
  const dropped = rows[index];
  if (dropped === undefined) {
    throw new UserError(`branch ${branch} is not in the stack`);
  }
  if (index !== 0 && index !== rows.length - 1) {
    throw new UserError(
      `branch ${branch} is in the middle of the stack; drop the top or the bottom row only`
    );
  }
  return { dropped, kept: rows.filter((row) => row !== dropped) };
}

/** Targets an open row may have: its parent, or what a merged parent had, because a forge moves the child when the parent lands. */
function acceptedTargets(
  rows: readonly ReadRow[],
  index: number
): ReadonlySet<string> {
  const accepted = new Set<string>();
  for (let at = index; at >= 0; at--) {
    accepted.add(rows[at].parent);
    if (rows[at - 1]?.state !== "MERGED") break;
  }
  return accepted;
}

/** Each message names a row whose open pull request does not target what stack.tsv says. */
export function chainDrift(rows: readonly ReadRow[]): readonly string[] {
  return rows.flatMap((row, index) => {
    if (row.state !== "OPEN") return [];
    const accepted = acceptedTargets(rows, index);
    return accepted.has(row.base)
      ? []
      : [
          `${row.branch} (#${row.pr}) targets ${row.base}, but stack.tsv has its parent as ${[...accepted].join(" or ")}`,
        ];
  });
}

/** Restack acts on the merged rows at the bottom. A merge above an unmerged row, or a closed row, needs the stacker first. */
export function planRestack(rows: readonly ReadRow[]): RestackPlan {
  const firstUnmerged = rows.findIndex((row) => row.state !== "MERGED");
  const landed = rows.slice(0, firstUnmerged < 0 ? rows.length : firstUnmerged);
  const survivors = rows.slice(landed.length);
  const misplaced = survivors.filter((row) => row.state === "MERGED");
  if (misplaced.length > 0) {
    throw new UserError(
      `${misplaced.map((row) => row.branch).join(", ")} merged while a branch below it is still unmerged; land the stack from the bottom`
    );
  }
  const bottom = landed[0];
  if (bottom === undefined) {
    return { kind: "nothing" };
  }
  const closed = survivors.filter((row) => row.state === "CLOSED");
  if (closed.length > 0) {
    throw new UserError(
      `${closed.map((row) => row.branch).join(", ")} is closed without a merge; drop it or reopen it before a restack`
    );
  }
  const [first, ...rest] = survivors;
  return first === undefined
    ? { kind: "drop-all", landed }
    : {
        kind: "rebase",
        landed,
        survivors: [first, ...rest],
        trunk: bottom.parent,
      };
}

/** The rows after a restack: the first survivor sits on the trunk tip and every other row on the tip of the row below. */
export function restackedRows(
  survivors: readonly StackRow[],
  trunk: BranchName,
  base: CommitSha,
  tipOf: (branch: BranchName) => CommitSha
): readonly StackRow[] {
  return survivors.map((row, index) => {
    const below = survivors[index - 1];
    return below === undefined
      ? { branch: row.branch, parent: trunk, parentTip: base }
      : {
          branch: row.branch,
          parent: below.branch,
          parentTip: tipOf(below.branch),
        };
  });
}
