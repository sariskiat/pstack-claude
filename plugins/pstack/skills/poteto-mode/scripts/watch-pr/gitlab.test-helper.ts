import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WatchDeadline } from "./deadline.ts";
import { type CommandResult } from "./github.ts";
import { GlabReader } from "./gitlab.ts";
import type * as T from "./types.ts";
import { parsePrNumber } from "./types.ts";

export const HOST = "gitlab.example.com";
export const PROJECT = "group/project";
export const TARGET_TIP = "d".repeat(40);
export const fixture = (name: string) =>
  JSON.parse(
    readFileSync(join(import.meta.dir, "fixtures", "gitlab", name), "utf8")
  );
export const context = (number: number, path = PROJECT): T.PrContext => ({
  host: HOST,
  path,
  number: parsePrNumber(number),
});
export const ok = (value: unknown): CommandResult => ({
  code: 0,
  stdout: JSON.stringify(value),
  stderr: "",
});
export const failure = (code: number, stderr: string): CommandResult => ({
  code,
  stdout: "",
  stderr,
});

export interface Served {
  readonly mr?: { readonly iid: number };
  readonly approvals?: unknown;
  readonly reviewers?: readonly unknown[];
  readonly discussions?: readonly unknown[];
  readonly jobs?: readonly unknown[];
  readonly mrList?: readonly unknown[];
  readonly pipelines?: readonly unknown[];
  readonly targetTips?: readonly string[];
}

export function server(served: Served) {
  const calls: string[][] = [];
  let branchReads = 0;
  const exec = async (argv: readonly string[]): Promise<CommandResult> => {
    calls.push([...argv]);
    const endpoint = argv[4] ?? "";
    const [path, query = ""] = endpoint.split("?");
    const page = Number(/(?:^|&)page=(\d+)/.exec(query)?.[1] ?? "1");
    const perPage = Number(/(?:^|&)per_page=(\d+)/.exec(query)?.[1] ?? "20");
    const slice = (items: readonly unknown[]): unknown[] =>
      items.slice((page - 1) * perPage, page * perPage);
    const branch = /\/repository\/branches\/([^/]+)$/.exec(path)?.[1];
    if (branch !== undefined) {
      const tips = served.targetTips ?? [TARGET_TIP];
      return ok({
        name: decodeURIComponent(branch),
        commit: { id: tips[Math.min(branchReads++, tips.length - 1)] },
      });
    }
    if (/\/merge_requests\/\d+$/.test(path)) return ok(served.mr);
    if (path.endsWith("/approvals")) return ok(served.approvals);
    if (path.endsWith("/reviewers")) return ok(slice(served.reviewers ?? []));
    if (path.endsWith("/discussions"))
      return ok(slice(served.discussions ?? []));
    if (path.endsWith("/jobs")) return ok(slice(served.jobs ?? []));
    if (path.endsWith("/pipelines")) return ok(slice(served.pipelines ?? []));
    if (path.endsWith("/merge_requests")) return ok(slice(served.mrList ?? []));
    return failure(1, `glab: 404 Not found (HTTP 404) ${endpoint}`);
  };
  return { exec, calls };
}

export function glabReader(
  served: Served,
  project: T.ProjectRef = { host: HOST, path: PROJECT }
) {
  const { exec, calls } = server(served);
  return {
    calls,
    reader: new GlabReader(project, new WatchDeadline(0, () => 0), { exec }),
  };
}
