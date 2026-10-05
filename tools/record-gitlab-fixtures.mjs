#!/usr/bin/env bun
// Records the glab api responses that the GitLab reader parses, keeps only the
// fields it reads, and rewrites every host, project path, user, and link so the
// output can be committed to a public repository.
//
//   bun tools/record-gitlab-fixtures.mjs <host> <project-path> <out-dir> <name>=<iid>...
//
// Per name it writes mr-<name>.json, approvals-<name>.json,
// reviewers-<name>.json, and discussions-<name>.json. When the merge request has
// a head pipeline it adds jobs-<name>.json. glab must be logged in to <host>.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const FAKE_HOST = "gitlab.example.com";
export const FAKE_PATH = "group/project";
export const FAKE_PROJECT_ID = 42;

const pick = (value, keys) =>
  Object.fromEntries(keys.filter((key) => key in value).map((key) => [key, value[key]]));

export function rewrite(value, { host, path }) {
  const literal = (text, from, to) => text.split(from).join(to);
  if (typeof value === "string")
    return literal(
      literal(literal(value, `https://${host}`, `https://${FAKE_HOST}`), encodeURIComponent(path), encodeURIComponent(FAKE_PATH)),
      path,
      FAKE_PATH,
    );
  if (Array.isArray(value)) return value.map((item) => rewrite(item, { host, path }));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item, { host, path })]));
  return value;
}

export function projectMergeRequest(mr) {
  return {
    ...pick(mr, [
      "iid",
      "title",
      "state",
      "draft",
      "sha",
      "source_branch",
      "target_branch",
      "detailed_merge_status",
      "merge_status",
      "has_conflicts",
      "blocking_discussions_resolved",
      "merged_at",
      "merge_commit_sha",
      "web_url",
    ]),
    source_project_id: FAKE_PROJECT_ID,
    target_project_id: FAKE_PROJECT_ID,
    diff_refs: mr.diff_refs && pick(mr.diff_refs, ["base_sha", "head_sha", "start_sha"]),
    head_pipeline:
      mr.head_pipeline && pick(mr.head_pipeline, ["id", "status", "sha", "ref", "source", "web_url"]),
  };
}

export const projectApprovals = (approvals) => ({
  ...pick(approvals, ["approved", "approvals_required", "approvals_left", "user_has_approved", "user_can_approve"]),
  approved_by: (approvals.approved_by ?? []).map((entry) => ({
    user: { username: "user" },
    approved_at: entry.approved_at,
  })),
});

export const projectReviewers = (reviewers) =>
  reviewers.map((reviewer) => ({
    user: { username: "user" },
    ...pick(reviewer, ["state", "created_at"]),
  }));

export const projectDiscussions = (discussions) =>
  discussions.map((discussion) => ({
    ...pick(discussion, ["id", "individual_note"]),
    notes: discussion.notes.map((note) => ({
      ...pick(note, ["id", "type", "body", "created_at", "system", "resolvable", "resolved"]),
      author: { username: "user" },
      position: note.position && pick(note.position, ["position_type", "new_path", "new_line", "old_path", "old_line"]),
    })),
  }));

export const projectJobs = (jobs) =>
  jobs.map((job) => pick(job, ["id", "name", "stage", "status", "allow_failure", "failure_reason", "web_url"]));

const glab = (host, endpoint) =>
  JSON.parse(execFileSync("glab", ["api", "--hostname", host, endpoint], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));

export function record({ host, path, outDir, scenarios }) {
  mkdirSync(outDir, { recursive: true });
  const project = `projects/${encodeURIComponent(path)}`;
  const write = (file, value) =>
    writeFileSync(join(outDir, file), `${JSON.stringify(rewrite(value, { host, path }), null, 2)}\n`);
  for (const [name, iid] of scenarios) {
    const mr = glab(host, `${project}/merge_requests/${iid}`);
    write(`mr-${name}.json`, projectMergeRequest(mr));
    write(`approvals-${name}.json`, projectApprovals(glab(host, `${project}/merge_requests/${iid}/approvals`)));
    write(`reviewers-${name}.json`, projectReviewers(glab(host, `${project}/merge_requests/${iid}/reviewers`)));
    write(`discussions-${name}.json`, projectDiscussions(glab(host, `${project}/merge_requests/${iid}/discussions?per_page=100`)));
    if (mr.head_pipeline)
      write(`jobs-${name}.json`, projectJobs(glab(host, `${project}/pipelines/${mr.head_pipeline.id}/jobs?per_page=100`)));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [host, path, outDir, ...pairs] = process.argv.slice(2);
  const scenarios = pairs.map((pair) => pair.split("="));
  if (!host || !path || !outDir || scenarios.length === 0 || scenarios.some(([name, iid]) => !/^[\w-]+$/.test(name) || !/^\d+$/.test(iid ?? ""))) {
    console.error("usage: bun tools/record-gitlab-fixtures.mjs <host> <project-path> <out-dir> <name>=<iid>...");
    process.exit(2);
  }
  record({ host, path, outDir, scenarios });
}
