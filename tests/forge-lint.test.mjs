import { test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { baselineAllowlist, check } from "../tools/forge-lint.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = "plugins/pstack/skills/poteto-mode/scripts";

function tree(files, body) {
  const root = mkdtempSync(join(tmpdir(), "forge-lint-"));
  try {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the repository is clean against its allowlist", () => {
  assert.deepEqual(check(repo).problems, []);
});

test("a raw gh call in a non-allowlisted file names the file and line", () => {
  const file = `${SCRIPTS}/watch-pr/policy.ts`;
  tree({ [file]: 'const a = 1;\nawait run("gh pr view 1");\n' }, (root) => {
    const { problems } = check(root, {});
    assert.equal(problems.length, 1);
    assert.match(problems[0], new RegExp(`^${file}:2:`));
  });
});

test("an argv-style call and a prose call are both caught", () => {
  tree(
    {
      [`${SCRIPTS}/a.ts`]: 'spawn(["glab", "mr", "view"]);\n',
      "plugins/pstack/skills/x/SKILL.md": "Run `gt submit` now.\n",
    },
    (root) => assert.equal(check(root, {}).problems.length, 2),
  );
});

test("the forge adapter and test files are exempt", () => {
  tree(
    {
      [`${SCRIPTS}/forge/forge.ts`]: 'run(["glab", "auth", "status"]);\n',
      [`${SCRIPTS}/watch-pr/github.ts`]: 'run(["gh", "pr", "view"]);\n',
      [`${SCRIPTS}/watch-pr/x.test.ts`]: 'run("gh pr view");\n',
    },
    (root) => assert.deepEqual(check(root, {}).problems, []),
  );
});

test("the allowlist only shrinks: fewer calls than allowed fails", () => {
  const file = `${SCRIPTS}/a.ts`;
  tree({ [file]: 'run("gh pr view");\n' }, (root) => {
    assert.deepEqual(check(root, { [file]: 1 }).problems, []);
    assert.match(check(root, { [file]: 2 }).problems[0], /lower the allowlist to 1/);
    assert.equal(check(root, { [file]: 0 }).problems.length, 1);
  });
});

const MISSED_CALLS = [
  "/opt/homebrew/bin/gh pr view 1",
  "~/bin/glab mr list",
  "gh --repo a/b pr view",
  "gh -R a/b pr view",
  "gh ${sub} view",
  "gh 123",
  "gh\tpr view",
  "gh.exe pr view",
  "run `glab\tmr view`",
  '"/usr/local/bin/gh"',
];

test("every call shape the first lint missed is now caught", () => {
  for (const text of MISSED_CALLS)
    tree({ [`${SCRIPTS}/a.ts`]: `${text}\n` }, (root) =>
      assert.equal(check(root, {}).problems.length, 1, text),
    );
});

test("plain words that only look like a forge command stay clean", () => {
  for (const text of [
    "the ghost and the gtk toolkit",
    "weight 5 and github.com",
    "missing from gt: a, b",
    'drift.push(`order differs: expected ${a}; gt ${b.join(",")}`);',
    "https://example.io/gt update",
    "my-gh pr and foo.gh pr",
    "docs/gt info",
  ])
    tree({ [`${SCRIPTS}/a.ts`]: `${text}\n` }, (root) =>
      assert.deepEqual(check(root, {}).problems, [], text),
    );
});

test("every text extension the first filter skipped is scanned", () => {
  for (const ext of ["tsx", "cjs", "mts", "cts", "jsx", "yml", "yaml", "py", "toml", "bash", "mdx"])
    tree({ [`${SCRIPTS}/a.${ext}`]: "gh pr view\n" }, (root) =>
      assert.equal(check(root, {}).problems.length, 1, ext),
    );
});

test("the adapter exemption is an exact file and a directory, not a prefix", () => {
  tree(
    {
      [`${SCRIPTS}/watch-pr/github.tsx`]: "gh pr view\n",
      [`${SCRIPTS}/watch-pr/github.ts.sh`]: "gh pr view\n",
      [`${SCRIPTS}/forgery/x.ts`]: "gh pr view\n",
    },
    (root) => assert.equal(check(root, {}).problems.length, 3),
  );
  tree({ [`${SCRIPTS}/forge/nested/x.ts`]: "gh pr view\n" }, (root) =>
    assert.deepEqual(check(root, {}).problems, []),
  );
});

test("the test-file exemption needs the exact .test or .test-helper suffix", () => {
  tree(
    {
      [`${SCRIPTS}/a.test.ts`]: "gh pr view\n",
      [`${SCRIPTS}/b.test.mjs`]: "gh pr view\n",
      [`${SCRIPTS}/fakes.test-helper.ts`]: "gh pr view\n",
    },
    (root) => assert.deepEqual(check(root, {}).problems, []),
  );
  tree(
    {
      [`${SCRIPTS}/a.test.ts.sh`]: "gh pr view\n",
      [`${SCRIPTS}/latest.ts`]: "gh pr view\n",
      [`${SCRIPTS}/a.test.md`]: "gh pr view\n",
    },
    (root) => assert.equal(check(root, {}).problems.length, 3),
  );
});

test("an allowlist count above the baseline fails, equal and lower pass", () => {
  const file = `${SCRIPTS}/a.ts`;
  tree({ [file]: 'run("gh pr view");\nrun("gh pr list");\n' }, (root) => {
    assert.deepEqual(check(root, { [file]: 2 }, { [file]: 2 }).problems, []);
    assert.match(
      check(root, { [file]: 2 }, { [file]: 1 }).problems[0],
      /allowlist 2 is above 1 at the merge base/,
    );
  });
});

test("an allowlist entry for a file the baseline lacks fails", () => {
  const file = `${SCRIPTS}/a.ts`;
  tree({ [file]: 'run("gh pr view");\n' }, (root) =>
    assert.match(check(root, { [file]: 1 }, {}).problems[0], /allowlist 1 is above 0/),
  );
});

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function lintSource(counts) {
  const body = Object.entries(counts)
    .map(([file, n]) => `  "${file}": ${n},`)
    .join("\n");
  return `export const ALLOWLIST = {\n${body}\n};\nexport const other = 1;\n`;
}

test("baselineAllowlist reads the allowlist at the merge base with a ref", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-lint-git-"));
  try {
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "t@example.com");
    git(root, "config", "user.name", "t");
    mkdirSync(join(root, "tools"), { recursive: true });
    writeFileSync(join(root, "README"), "x\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "base without lint");
    git(root, "branch", "empty-base");
    writeFileSync(join(root, "tools/forge-lint.mjs"), lintSource({ "a.md": 3, "b.md": 1 }));
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "lint at 3 and 1");
    git(root, "branch", "lint-base");
    writeFileSync(join(root, "tools/forge-lint.mjs"), lintSource({ "a.md": 9, "b.md": 1 }));
    git(root, "commit", "-q", "-am", "raise a.md");
    assert.equal(baselineAllowlist(root, "empty-base"), null);
    assert.deepEqual(baselineAllowlist(root, "lint-base"), { "a.md": 3, "b.md": 1 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
