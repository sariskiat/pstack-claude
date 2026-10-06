// Opt-in live verification against a sandbox GitLab project. Writes only branches, files, and one merge request of its own run,
// merges only into its own target branch, and never deletes a project.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { isHostname, isProjectPath } from "../forge/forge.ts";
import { glabApiJson, glabMergeArgv } from "./shipping-gitlab.ts";

const SANDBOX_NAME = "pstack-sandbox";
const usage =
  "Usage: bun watch-pr/live-merge-safety-gitlab.mjs --live-sandbox --host <host> --project <group/project>";
const args = process.argv.slice(2);
const flagValue = (name) => args[args.indexOf(name) + 1];
if (
  args.length !== 5 ||
  args[0] !== "--live-sandbox" ||
  args[1] !== "--host" ||
  args[3] !== "--project"
) {
  console.error(usage);
  process.exit(2);
}
const host = flagValue("--host").toLowerCase();
const path = flagValue("--project");
if (!isHostname(host) || !isProjectPath(path)) {
  console.error(`${usage}\nThe host or the project path is not valid.`);
  process.exit(2);
}
if (path.split("/").at(-1) !== SANDBOX_NAME) {
  console.error(
    `Refusing ${path}: only a project named ${SANDBOX_NAME} is a sandbox.`
  );
  process.exit(2);
}

const exec = async (argv) => {
  const result = spawnSync(argv[0], argv.slice(1), { encoding: "utf8" });
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
};
const id = randomUUID().slice(0, 8);
const prefix = `f3-live-${id}-`;
const target = `${prefix}target`;
const source = `${prefix}source`;
const project = `projects/${encodeURIComponent(path)}`;
const branchPath = (name) =>
  `${project}/repository/branches/${encodeURIComponent(name)}`;

function guardedWrite(method, endpoint, fields) {
  const ownBranch = (name) =>
    assert.ok(
      String(name).startsWith(prefix),
      `${name} is not a branch of this run`
    );
  assert.ok(
    endpoint.startsWith(`${project}/`),
    "a write must stay inside the sandbox project"
  );
  if (method === "DELETE") {
    assert.ok(
      endpoint.startsWith(
        `${project}/repository/branches/${encodeURIComponent(prefix)}`
      ),
      `a delete may only remove a branch of this run: ${endpoint}`
    );
  }
  if (endpoint === `${project}/repository/branches`) ownBranch(fields.branch);
  if (endpoint.includes("/repository/files/")) ownBranch(fields.branch);
  if (endpoint === `${project}/merge_requests`) {
    ownBranch(fields.source_branch);
    ownBranch(fields.target_branch);
  }
}
const read = (endpoint) => glabApiJson(exec, host, endpoint);
const write = (method, endpoint, fields = {}) => {
  guardedWrite(method, endpoint, fields);
  return glabApiJson(exec, host, endpoint, { method, fields });
};

const shippingCli = fileURLToPath(new URL("./ship-pr", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "pstack-live-shipping-gitlab-"));
const ship = (...shipArgs) => {
  const result = spawnSync("bun", [shippingCli, ...shipArgs], {
    encoding: "utf8",
  });
  return { status: result.status, output: JSON.parse(result.stdout) };
};
let iid;
const created = [];
const context = () => ({ host, path, number: iid });
function inspect() {
  const result = ship(
    "inspect",
    "--host",
    host,
    "--repo",
    path,
    "--pr",
    String(iid)
  );
  assert.equal(result.output.kind, "inspected", JSON.stringify(result.output));
  assert.equal(result.status, 0);
  return result.output.record;
}
function cancel(record, expectedKind) {
  const file = join(scratch, "landing.json");
  writeFileSync(file, JSON.stringify({ kind: "inspected", record }));
  const result = ship("cancel-pending", "--record", file);
  assert.equal(result.output.kind, expectedKind, JSON.stringify(result.output));
  assert.equal(result.status, expectedKind === "cancelled" ? 0 : 1);
}
async function waitFor(label, readOnce, matches) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const facts = await readOnce();
      if (matches(facts)) return facts;
    } catch {
      // A merge request that GitLab is still computing or merging is not readable yet.
    }
    await delay(1000);
  }
  throw new Error(`fixture did not reach ${label}`);
}
const tip = async (branch) => (await read(branchPath(branch))).commit.id;
async function waitForMergeable(head, base, baseTip) {
  await waitFor(
    "the expected head and mergeable status",
    () => read(`${project}/merge_requests/${iid}`),
    (mr) =>
      mr.sha === head &&
      mr.target_branch === base &&
      mr.detailed_merge_status === "mergeable" &&
      mr.diff_refs?.head_sha === head
  );
  return waitFor(
    "the expected landing revision",
    async () => inspect(),
    (record) =>
      record.revision.headRefOid === head &&
      record.revision.baseRefName === base &&
      (baseTip === undefined || record.revision.baseRefOid === baseTip)
  );
}
const putFile = (branch, file, content, message, exists) =>
  write(
    exists ? "PUT" : "POST",
    `${project}/repository/files/${encodeURIComponent(file)}`,
    {
      branch,
      content,
      commit_message: `${message} [skip ci]`,
    }
  );
function merge(headSha) {
  const argv = glabMergeArgv({ context: context(), headSha });
  console.log(`RUN ${argv.join(" ")}`);
  const result = spawnSync(argv[0], argv.slice(1), { encoding: "utf8" });
  const text = `${result.stdout}${result.stderr}`
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" | ");
  return { status: result.status, text: text.slice(0, 300) };
}

try {
  const info = await read(project);
  assert.equal(info.path_with_namespace.toLowerCase(), path.toLowerCase());
  assert.equal(info.archived, false);
  console.log(`Sandbox ${path} on ${host}, run ${id}, own branches ${prefix}*`);
  for (const [branch, ref] of [
    [target, info.default_branch],
    [source, target],
  ]) {
    await write("POST", `${project}/repository/branches`, { branch, ref });
    created.push(branch);
  }
  await putFile(source, "fixture.txt", "first\n", "Add fixture", false);
  const approvedHead = await tip(source);
  iid = (
    await write("POST", `${project}/merge_requests`, {
      source_branch: source,
      target_branch: target,
      title: `Disposable merge safety test ${id}`,
    })
  ).iid;
  console.log(`Created merge request !${iid}: ${source} into ${target}`);

  console.log("STALE HEAD");
  const original = inspect();
  assert.equal(original.revision.headRefOid, approvedHead);
  assert.equal(original.revision.baseRefName, target);
  assert.equal(original.revision.baseRefOid, await tip(target));
  assert.equal(original.pending.autoMerge, false);
  assert.equal(original.pending.queueEntryId, null);
  assert.equal(original.state, "OPEN");
  cancel(original, "cancelled");
  console.log("PASS: both pending mechanisms read independently as absent");

  await putFile(
    source,
    "fixture.txt",
    "second\n",
    "Change after verification",
    true
  );
  const nextHead = await tip(source);
  const beforeBaseMove = await waitForMergeable(nextHead, target);
  cancel(original, "changed");
  await putFile(
    target,
    "base-fixture.txt",
    "base advance\n",
    "Advance base",
    false
  );
  const advancedTip = await tip(target);
  await waitForMergeable(nextHead, target, advancedTip);
  cancel(beforeBaseMove, "changed");
  console.log(
    "PASS: canonical cancellation rejects changed head and base revision records"
  );

  const stale = merge(approvedHead);
  assert.notEqual(
    stale.status,
    0,
    `the old verified head must be refused: ${stale.text}`
  );
  assert.match(
    stale.text,
    /sha|409|does not match/i,
    `refused for another reason: ${stale.text}`
  );
  console.log(`merge output: ${stale.text}`);
  assert.equal(inspect().state, "OPEN");
  console.log(
    "PASS: stale head rejected by the live merge command; merge request remains open"
  );

  let refused = false;
  try {
    await write("PUT", `${project}/merge_requests/${iid}/merge`, {
      sha: approvedHead,
    });
  } catch (error) {
    if (!/409|does not match/i.test(String(error.message))) throw error;
    console.log(`REST merge answer: ${error.message}`);
    refused = true;
  }
  assert.equal(
    refused,
    true,
    "the merge endpoint must reject a mismatched sha"
  );
  assert.equal(inspect().state, "OPEN");
  assert.equal(inspect().revision.headRefOid, nextHead);
  console.log(
    "PASS: REST merge endpoint rejects the stale sha with HTTP 409; head unchanged"
  );

  console.log("CURRENT HEAD");
  const current = merge(nextHead);
  assert.equal(
    current.status,
    0,
    `the current head must merge: ${current.text}`
  );
  console.log(`merge output: ${current.text}`);
  const merged = await waitFor(
    "merged state",
    async () => inspect(),
    (record) => record.state === "MERGED"
  );
  assert.equal(merged.revision.headRefOid, nextHead);
  assert.equal(merged.revision.baseRefName, target);
  assert.ok(
    merged.mergeCommitOid,
    "a merged merge request reports its merge commit"
  );
  console.log(
    `PASS: current head merged into ${target}; inspect reports MERGED with merge commit ${merged.mergeCommitOid}`
  );

  console.log("MERGED RECORD");
  console.log(`ship-pr inspect: ${JSON.stringify(merged)}`);
  const targetTip = await tip(target);
  console.log(`tip of ${target}: ${targetTip}`);
  assert.equal(targetTip, merged.mergeCommitOid);
  const file = await read(
    `${project}/repository/files/fixture.txt?ref=${encodeURIComponent(target)}`
  );
  assert.equal(Buffer.from(file.content, "base64").toString(), "second\n");
  const baseFile = await read(
    `${project}/repository/files/base-fixture.txt?ref=${encodeURIComponent(target)}`
  );
  assert.equal(
    Buffer.from(baseFile.content, "base64").toString(),
    "base advance\n"
  );
  console.log(
    "PASS: mergeCommitOid equals the tip of the target branch, and the target holds the merged and the advanced content"
  );
  console.log(
    "LIMIT: active auto-merge on a running pipeline is exercised by the lane driver. A Community Edition server has no merge trains. Protection settings are unchanged."
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
  if (iid !== undefined) {
    try {
      await write("PUT", `${project}/merge_requests/${iid}`, {
        state_event: "close",
      });
    } catch {
      // Already merged or closed.
    }
  }
  for (const branch of created) {
    try {
      await write("DELETE", branchPath(branch));
    } catch {
      // Already removed by the project's remove-source-branch setting.
    }
  }
  console.log(
    `Removed the branches of run ${id} that still existed. The project stays.`
  );
}
