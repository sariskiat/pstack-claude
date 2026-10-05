import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { check } from "../tools/forge-lint.mjs";

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
