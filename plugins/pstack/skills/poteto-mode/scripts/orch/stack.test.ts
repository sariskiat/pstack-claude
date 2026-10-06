import { describe, expect, it } from "bun:test";
import { UserError } from "./errors.ts";
import {
  appendRow,
  chainDrift,
  dropRow,
  parseBranchName,
  parseCommitSha,
  parseStack,
  planRestack,
  restackedRows,
  stackCells,
  type ReadRow,
  type StackRow,
} from "./stack.ts";
import type { FrontierPrState } from "./store.ts";

const branch = (value: string) => parseBranchName(value, "branch");
const sha = (digit: string) => parseCommitSha(digit.repeat(40), "sha");

function row(name: string, parent: string, digit: string): StackRow {
  return {
    branch: branch(name),
    parent: branch(parent),
    parentTip: sha(digit),
  };
}

const BOTTOM = row("lane/bottom", "main", "a");
const MIDDLE = row("lane/middle", "lane/bottom", "b");
const TOP = row("lane/top", "lane/middle", "c");
const CHAIN: readonly StackRow[] = [BOTTOM, MIDDLE, TOP];

/** The chain with the states the forge reports and the target each pull request has (default: its parent). */
function read(
  states: readonly FrontierPrState[],
  bases: readonly string[] = []
): readonly ReadRow[] {
  return CHAIN.map((item, index) => ({
    ...item,
    pr: index + 1,
    state: states[index] ?? "OPEN",
    base: bases[index] ?? item.parent,
  }));
}

describe("branch and commit parsing", () => {
  it("accepts ordinary branch names", () => {
    for (const name of [
      "main",
      "feat/x-1",
      "poteto/u1",
      "a.b_c+d=e@f#g,h%i",
      "_x",
    ]) {
      expect(parseBranchName(name, "branch")).toBe(name as never);
    }
  });

  it("rejects names that break git, TSV, or argv", () => {
    const bad = [
      "",
      "-x",
      "--upload-pack=/tmp/pwn",
      "a b",
      "a\tb",
      "a\nb",
      "a..b",
      "a//b",
      "a/",
      "a.",
      "a@{1}",
      "a/.hidden",
      "a.lock",
      "a/b.lock",
      "=SUM(A1)",
      "+x",
      "@x",
      ".x",
      "/x",
      "a~1",
      "a^b",
      "a:b",
      "a'b",
    ];
    for (const name of bad) {
      expect(() => parseBranchName(name, "branch"), name).toThrow(UserError);
    }
  });

  it("accepts a full SHA in either case and rejects an abbreviation", () => {
    expect(parseCommitSha("ABCDEF1234".repeat(4), "sha")).toBe(
      "abcdef1234".repeat(4) as never
    );
    expect(parseCommitSha("a".repeat(64), "sha")).toBeDefined();
    expect(() => parseCommitSha("abc1234", "sha")).toThrow("full commit SHA");
    expect(() => parseCommitSha("g".repeat(40), "sha")).toThrow(UserError);
  });
});

describe("stack chain", () => {
  it("parses rows from TSV cells", () => {
    expect(parseStack(CHAIN.map(stackCells))).toEqual(CHAIN);
  });

  it("rejects a duplicate branch, a gap, a self parent, and a bottom parent inside the stack", () => {
    expect(() =>
      parseStack([...CHAIN.map(stackCells), stackCells(BOTTOM)])
    ).toThrow("lists branch lane/bottom twice");
    expect(() => parseStack([stackCells(BOTTOM), stackCells(TOP)])).toThrow(
      "must be one chain"
    );
    expect(() => parseStack([stackCells(row("x", "x", "a"))])).toThrow(
      "is its own parent"
    );
    expect(() =>
      parseStack([
        stackCells(row("a", "c", "a")),
        stackCells(row("b", "a", "b")),
        stackCells(row("c", "b", "c")),
      ])
    ).toThrow("a branch above it");
  });

  it("names the row and the cell when a value is malformed", () => {
    expect(() => parseStack([["a b", "main", "a".repeat(40)]])).toThrow(
      "stack.tsv row 1 branch"
    );
    expect(() => parseStack([["a", "main", "xyz"]])).toThrow(
      "stack.tsv row 1 parent_tip"
    );
  });

  it("appends only on top of the stack", () => {
    expect(appendRow([], BOTTOM)).toEqual([BOTTOM]);
    expect(appendRow(CHAIN, row("lane/next", "lane/top", "d"))).toHaveLength(4);
    expect(() => appendRow(CHAIN, row("lane/next", "main", "d"))).toThrow(
      "must be one chain"
    );
    expect(() => appendRow(CHAIN, row("lane/top", "lane/top", "d"))).toThrow(
      "lists branch lane/top twice"
    );
    expect(() => appendRow(CHAIN, row("lane/bottom", "lane/top", "d"))).toThrow(
      "lists branch lane/bottom twice"
    );
  });

  it("drops the top or the bottom row and refuses the middle", () => {
    expect(dropRow(CHAIN, TOP.branch)).toEqual({
      dropped: TOP,
      kept: [BOTTOM, MIDDLE],
    });
    expect(dropRow(CHAIN, BOTTOM.branch)).toEqual({
      dropped: BOTTOM,
      kept: [MIDDLE, TOP],
    });
    expect(() => dropRow(CHAIN, MIDDLE.branch)).toThrow("in the middle");
    expect(() => dropRow(CHAIN, branch("nope"))).toThrow("is not in the stack");
  });
});

describe("chain drift", () => {
  it("reports nothing when every open row targets its parent", () => {
    expect(chainDrift(read(["OPEN", "OPEN", "OPEN"]))).toEqual([]);
  });

  it("reports a row whose open pull request targets another branch", () => {
    expect(
      chainDrift(
        read(["OPEN", "OPEN", "OPEN"], ["main", "main", "lane/middle"])
      )
    ).toEqual([
      "lane/middle (#2) targets main, but stack.tsv has its parent as lane/bottom",
    ]);
  });

  it("accepts the target of a merged parent, and only that", () => {
    const merged: readonly FrontierPrState[] = ["MERGED", "OPEN", "OPEN"];
    expect(chainDrift(read(merged, ["main", "main", "lane/middle"]))).toEqual(
      []
    );
    expect(
      chainDrift(read(merged, ["main", "lane/bottom", "lane/middle"]))
    ).toEqual([]);
    expect(
      chainDrift(read(merged, ["main", "release", "lane/middle"]))
    ).toEqual([
      "lane/middle (#2) targets release, but stack.tsv has its parent as lane/bottom or main",
    ]);
  });

  it("reads through two merged parents", () => {
    const merged: readonly FrontierPrState[] = ["MERGED", "MERGED", "OPEN"];
    expect(chainDrift(read(merged, ["main", "main", "main"]))).toEqual([]);
    expect(chainDrift(read(merged, ["main", "main", "other"]))).toHaveLength(1);
  });

  it("does not judge a merged or closed row", () => {
    expect(
      chainDrift(read(["MERGED", "CLOSED", "OPEN"], ["x", "y", "lane/middle"]))
    ).toEqual([]);
  });
});

describe("restack plan", () => {
  it("does nothing when no row has merged", () => {
    expect(planRestack(read(["OPEN", "OPEN", "OPEN"]))).toEqual({
      kind: "nothing",
    });
  });

  it("rebases the rows above the merged prefix onto the trunk of the bottom row", () => {
    const rows = read(["MERGED", "OPEN", "OPEN"]);
    expect(planRestack(rows)).toEqual({
      kind: "rebase",
      landed: [rows[0] as ReadRow],
      survivors: [rows[1] as ReadRow, rows[2] as ReadRow],
      trunk: branch("main"),
    });
    const two = planRestack(read(["MERGED", "MERGED", "OPEN"]));
    expect(two.kind === "rebase" && two.survivors.map((r) => r.branch)).toEqual(
      [TOP.branch]
    );
  });

  it("only drops rows when everything merged", () => {
    const rows = read(["MERGED", "MERGED", "MERGED"]);
    expect(planRestack(rows)).toEqual({ kind: "drop-all", landed: rows });
  });

  it("refuses a merge above an unmerged row and a closed survivor", () => {
    expect(() => planRestack(read(["OPEN", "MERGED", "OPEN"]))).toThrow(
      "land the stack from the bottom"
    );
    expect(() => planRestack(read(["MERGED", "CLOSED", "OPEN"]))).toThrow(
      "lane/middle is closed without a merge"
    );
  });

  it("puts the first survivor on the trunk tip and each other row on the tip below", () => {
    const tips = new Map([[MIDDLE.branch, sha("1")]]);
    expect(
      restackedRows([MIDDLE, TOP], branch("main"), sha("f"), (name) => {
        const tip = tips.get(name);
        if (tip === undefined) throw new Error(`no tip for ${name}`);
        return tip;
      })
    ).toEqual([
      { branch: MIDDLE.branch, parent: branch("main"), parentTip: sha("f") },
      { branch: TOP.branch, parent: MIDDLE.branch, parentTip: sha("1") },
    ]);
  });
});
