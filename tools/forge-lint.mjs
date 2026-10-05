#!/usr/bin/env node

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCOPE = "plugins/pstack";
const ADAPTERS = [
  "plugins/pstack/skills/poteto-mode/scripts/forge/",
  "plugins/pstack/skills/poteto-mode/scripts/watch-pr/github.ts",
];
const TEXT_FILE = /(^|\/)[^./]+$|\.(ts|mjs|js|sh|md|json)$/;
const TEST_FILE = /\.test\.|\.test-helper\./;
const SKIPPED_DIRS = new Set(["node_modules", ".git"]);
const CALLS = [
  /(?<![\w./$-])(?:gh|glab|gt)(?= +[a-z])/g,
  /["'`](?:gh|glab|gt)["'`]/g,
];

export const ALLOWLIST = {
  "plugins/pstack/skills/babysit/SKILL.md": 5,
  "plugins/pstack/skills/fix-ci/SKILL.md": 2,
  "plugins/pstack/skills/make-pr-easy-to-review/SKILL.md": 1,
  "plugins/pstack/skills/poteto-mode/SKILL.md": 1,
  "plugins/pstack/skills/poteto-mode/playbooks/autopilot-full.md": 3,
  "plugins/pstack/skills/poteto-mode/playbooks/autopilot-stack.md": 6,
  "plugins/pstack/skills/poteto-mode/playbooks/babysit.md": 5,
  "plugins/pstack/skills/poteto-mode/playbooks/multi-phase-plan.md": 4,
  "plugins/pstack/skills/poteto-mode/playbooks/opening-a-pr.md": 8,
  "plugins/pstack/skills/poteto-mode/playbooks/orchestrate.md": 7,
  "plugins/pstack/skills/poteto-mode/playbooks/shipping.md": 4,
  "plugins/pstack/skills/poteto-mode/references/codex-tools.md": 2,
  "plugins/pstack/skills/poteto-mode/references/merge-safety.md": 1,
  "plugins/pstack/skills/poteto-mode/references/pi-tools.md": 3,
  "plugins/pstack/skills/poteto-mode/scripts/orch/store.ts": 15,
  "plugins/pstack/skills/poteto-mode/scripts/watch-pr/live-merge-safety.mjs": 3,
  "plugins/pstack/skills/poteto-mode/scripts/watch-pr/shipping.ts": 3,
  "plugins/pstack/skills/poteto-mode/scripts/worktree-audit.mjs": 3,
  "plugins/pstack/skills/recall/SKILL.md": 1,
  "plugins/pstack/skills/why/SKILL.md": 4,
  "plugins/pstack/skills/why/references/source-playbook.md": 1,
  "plugins/pstack/skills/why/references/sources/code-archaeology.md": 2,
  "plugins/pstack/skills/why/references/synthesizer-prompt.md": 1,
};

export function* sourceFiles(root, dir = join(root, SCOPE)) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(root, path);
    else if (entry.isFile()) yield relative(root, path).split(sep).join("/");
  }
}

export function scan(root) {
  const hits = new Map();
  for (const file of sourceFiles(root)) {
    if (!TEXT_FILE.test(file) || TEST_FILE.test(file)) continue;
    if (ADAPTERS.some((adapter) => file.startsWith(adapter))) continue;
    readFileSync(join(root, file), "utf8")
      .split("\n")
      .forEach((text, index) => {
        const count = CALLS.reduce((n, re) => n + (text.match(re)?.length ?? 0), 0);
        if (count === 0) return;
        if (!hits.has(file)) hits.set(file, []);
        hits.get(file).push({ line: index + 1, text: text.trim(), count });
      });
  }
  return hits;
}

export function check(root, allowlist = ALLOWLIST) {
  const hits = scan(root);
  const problems = [];
  for (const [file, lines] of hits) {
    const total = lines.reduce((n, l) => n + l.count, 0);
    const allowed = allowlist[file] ?? 0;
    if (total > allowed)
      for (const { line, text } of lines)
        problems.push(`${file}:${line}: raw forge call outside the adapter (${total} found, ${allowed} allowed): ${text.slice(0, 100)}`);
    else if (total < allowed)
      problems.push(`${file}: ${total} raw forge calls but ${allowed} allowed; lower the allowlist to ${total}`);
  }
  for (const [file, allowed] of Object.entries(allowlist))
    if (!hits.has(file)) problems.push(`${file}: no raw forge calls but ${allowed} allowed; delete its allowlist entry`);
  const allowlisted = [...hits].reduce(
    (n, [file, lines]) => n + Math.min(allowlist[file] ?? 0, lines.reduce((m, l) => m + l.count, 0)),
    0,
  );
  return { problems, allowlisted, files: Object.keys(allowlist).length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const flag = process.argv.indexOf("--root");
  const root = flag === -1 ? join(dirname(fileURLToPath(import.meta.url)), "..") : process.argv[flag + 1];
  const { problems, allowlisted, files } = check(root);
  for (const problem of problems) console.error(problem);
  console.log(`forge-lint: ${allowlisted} allowlisted raw forge calls in ${files} files`);
  process.exit(problems.length === 0 ? 0 : 1);
}
