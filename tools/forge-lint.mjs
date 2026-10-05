#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCOPE = "plugins/pstack";
const ADAPTER_DIRS = ["plugins/pstack/skills/poteto-mode/scripts/forge/"];
const ADAPTER_FILES = new Set([
  "plugins/pstack/skills/poteto-mode/scripts/watch-pr/github.ts",
]);
const TEXT_FILE =
  /(^|\/)[^./]+$|\.(?:[cm]?[jt]sx?|sh|bash|zsh|mdx?|json|ya?ml|py|toml|txt)$/;
const TEST_FILE = /\.(?:test|test-helper)\.[cm]?[jt]sx?$/;
const SKIPPED_DIRS = new Set(["node_modules", ".git"]);
const COMMAND = "(?:gh|glab|gt)(?:\\.exe)?";
const ARGUMENTS =
  "(?=[ \\t]+(?:[a-z0-9]|-{1,2}[A-Za-z]|\\$\\{[^}]*\\}[ \\t]+[a-z]))";
const CALLS = [
  new RegExp(`(?<![\\w.$@:/~-])${COMMAND}${ARGUMENTS}`, "g"),
  new RegExp(
    `(?<![\\w.$@:/-])(?:~|\\.{1,2})?(?:/[\\w.@+~-]+)*/${COMMAND}${ARGUMENTS}`,
    "g",
  ),
  /["'`](?:[^"'`\s]*\/)?(?:gh|glab|gt)(?:\.exe)?["'`]/g,
];
const isAdapter = (file) =>
  ADAPTER_FILES.has(file) || ADAPTER_DIRS.some((dir) => file.startsWith(dir));

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
    if (isAdapter(file)) continue;
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

const ALLOWLIST_LITERAL = /export const ALLOWLIST = (\{[^}]*\});/;

export function baselineAllowlist(root, ref) {
  const git = (...args) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const base = git("merge-base", "HEAD", ref);
  let source;
  try {
    source = git("show", `${base}:tools/forge-lint.mjs`);
  } catch {
    return null;
  }
  const literal = ALLOWLIST_LITERAL.exec(source);
  if (literal === null) throw new Error(`no ALLOWLIST literal in tools/forge-lint.mjs at ${base}`);
  return JSON.parse(literal[1].replace(/,\s*\}$/, "}"));
}

export function check(root, allowlist = ALLOWLIST, baseline = null) {
  const hits = scan(root);
  const problems = [];
  if (baseline !== null)
    for (const [file, allowed] of Object.entries(allowlist))
      if (allowed > (baseline[file] ?? 0))
        problems.push(`${file}: allowlist ${allowed} is above ${baseline[file] ?? 0} at the merge base; the allowlist may only shrink`);
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
  const baseFlag = process.argv.indexOf("--base");
  const explicit = baseFlag === -1 ? process.env.FORGE_LINT_BASE : process.argv[baseFlag + 1];
  const ref = explicit ?? "origin/main";
  let baseline = null;
  const unreadable = [];
  try {
    baseline = baselineAllowlist(root, ref);
    if (baseline === null) console.log(`forge-lint: tools/forge-lint.mjs is new relative to ${ref}; growth not checked`);
  } catch (error) {
    const reason = `cannot read the allowlist at the merge base with ${ref}: ${error.message.split("\n")[0]}`;
    if (explicit === undefined) console.log(`forge-lint: ${reason}; growth not checked`);
    else unreadable.push(reason);
  }
  const { problems, allowlisted, files } = check(root, ALLOWLIST, baseline);
  problems.push(...unreadable);
  for (const problem of problems) console.error(problem);
  console.log(`forge-lint: ${allowlisted} allowlisted raw forge calls in ${files} files`);
  process.exit(problems.length === 0 ? 0 : 1);
}
