import { describe, expect, test } from "bun:test";

import {
  FAKE_HOST,
  FAKE_PATH,
  projectApprovals,
  projectDiscussions,
  projectJobs,
  projectMergeRequest,
  rewrite,
} from "../tools/record-gitlab-fixtures.mjs";

const where = { host: "git.corp.example.net", path: "team-a/tools/app" };

describe("rewrite", () => {
  test("replaces the host, the project path, and its URL-encoded form in every string", () => {
    const out = rewrite(
      {
        web_url: "https://git.corp.example.net/team-a/tools/app/-/merge_requests/3",
        api: "projects/team-a%2Ftools%2Fapp/merge_requests/3",
        nested: [{ text: "see team-a/tools/app and https://git.corp.example.net/x" }],
        number: 7,
        flag: null,
      },
      where,
    );
    expect(out).toEqual({
      web_url: `https://${FAKE_HOST}/${FAKE_PATH}/-/merge_requests/3`,
      api: `projects/${encodeURIComponent(FAKE_PATH)}/merge_requests/3`,
      nested: [{ text: `see ${FAKE_PATH} and https://${FAKE_HOST}/x` }],
      number: 7,
      flag: null,
    });
    expect(JSON.stringify(out)).not.toContain("corp.example.net");
    expect(JSON.stringify(out)).not.toContain("team-a");
  });
});

describe("the projections keep only what the reader parses", () => {
  const mr = {
    iid: 3,
    title: "A title",
    state: "opened",
    draft: false,
    sha: "a".repeat(40),
    source_branch: "feature",
    target_branch: "main",
    detailed_merge_status: "mergeable",
    merge_status: "can_be_merged",
    has_conflicts: false,
    blocking_discussions_resolved: true,
    merged_at: null,
    merge_commit_sha: null,
    web_url: "https://git.corp.example.net/team-a/tools/app/-/merge_requests/3",
    source_project_id: 5259,
    target_project_id: 5259,
    author: { name: "Real Name", username: "real.user", avatar_url: "https://git.corp.example.net/avatar.png" },
    merged_by: { name: "Real Name" },
    description: "mentions real.user@example.net",
    diff_refs: { base_sha: "b".repeat(40), head_sha: "a".repeat(40), start_sha: "c".repeat(40) },
    head_pipeline: {
      id: 9,
      status: "success",
      sha: "a".repeat(40),
      ref: "feature",
      source: "push",
      web_url: "https://git.corp.example.net/team-a/tools/app/-/pipelines/9",
      user: { name: "Real Name", username: "real.user" },
    },
  };

  test("a merge request drops its author, merger, description, and avatar and masks the project ids", () => {
    const out = projectMergeRequest(mr);
    expect(Object.keys(out)).not.toContain("author");
    expect(Object.keys(out)).not.toContain("merged_by");
    expect(Object.keys(out)).not.toContain("description");
    expect(out.head_pipeline).not.toHaveProperty("user");
    expect(out.source_project_id).toBe(42);
    expect(out.target_project_id).toBe(42);
    expect(out.detailed_merge_status).toBe("mergeable");
    expect(out.diff_refs).toEqual(mr.diff_refs);
    const text = JSON.stringify(rewrite(out, where));
    for (const leak of ["Real Name", "real.user", "avatar", "corp.example.net", "5259"]) expect(text).not.toContain(leak);
  });

  test("a merge request with no pipeline or diff keeps them null", () => {
    const out = projectMergeRequest({ ...mr, head_pipeline: null, diff_refs: null });
    expect(out.head_pipeline).toBeNull();
    expect(out.diff_refs).toBeNull();
  });

  test("approvals, discussions, and jobs name no person", () => {
    const approvals = projectApprovals({
      approved: true,
      user_has_approved: true,
      user_can_approve: false,
      approved_by: [{ user: { name: "Real Name", username: "real.user" }, approved_at: "2026-01-01T00:00:00Z" }],
    });
    const discussions = projectDiscussions([
      {
        id: "d1",
        individual_note: false,
        notes: [
          {
            id: 1,
            type: "DiffNote",
            body: "text",
            created_at: "2026-01-01T00:00:00Z",
            system: false,
            resolvable: true,
            resolved: false,
            author: { name: "Real Name", username: "real.user", avatar_url: "x" },
            position: { position_type: "text", new_path: "a.txt", new_line: 1, old_path: null, old_line: null, base_sha: "z" },
          },
        ],
      },
    ]);
    const jobs = projectJobs([
      { id: 1, name: "unit", stage: "test", status: "failed", allow_failure: false, failure_reason: "script_failure", web_url: "u", user: { name: "Real Name" }, runner: { description: "corp-runner" } },
    ]);
    const text = JSON.stringify({ approvals, discussions, jobs });
    for (const leak of ["Real Name", "real.user", "avatar", "corp-runner", "base_sha"]) expect(text).not.toContain(leak);
    expect(approvals.approved_by).toEqual([{ user: { username: "user" }, approved_at: "2026-01-01T00:00:00Z" }]);
    expect(discussions[0].notes[0].author).toEqual({ username: "user" });
    expect(discussions[0].notes[0].position).toEqual({ position_type: "text", new_path: "a.txt", new_line: 1, old_path: null, old_line: null });
  });
});
