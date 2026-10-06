import {
  ForgeError,
  detectForgeEnv,
  isHostname,
  isProjectPath,
  resolveForge,
  type ProjectRef,
} from "../forge/forge.ts";
import { WatcherQueryError, prNumberField } from "./github.ts";
import type { CommandResult } from "./github.ts";
import {
  glabFailure,
  invalid,
  objectId,
  parseBody,
  positiveInteger,
  readPages,
  transient,
} from "./gitlab.ts";
import { flag, object, oneOf, text } from "./landing.ts";
import type { LandingRecord, ShippingService } from "./shipping.ts";
import type { PrContext, PrNumber } from "./types.ts";

export type GlabExec = (
  argv: readonly [string, ...string[]]
) => Promise<CommandResult>;

/** Fields only go with an explicit method, because glab turns a request with fields into a POST. */
export type GlabRequest =
  | { readonly method?: undefined }
  | {
      readonly method: "POST" | "PUT" | "DELETE";
      readonly fields?: Readonly<Record<string, string>>;
    };

/** Runs one `glab api` request. A body that is empty, as after a DELETE, reads as null. */
export async function glabApiJson(
  exec: GlabExec,
  host: string,
  endpoint: string,
  request: GlabRequest = {}
): Promise<unknown> {
  const options =
    request.method === undefined
      ? []
      : [
          "--method",
          request.method,
          ...Object.entries(request.fields ?? {}).flatMap(([key, value]) => [
            "--raw-field",
            `${key}=${value}`,
          ]),
        ];
  const result = await exec([
    "glab",
    "api",
    "--hostname",
    host,
    ...options,
    endpoint,
  ]);
  if (result.code !== 0) throw glabFailure(result, host, endpoint);
  return result.stdout.trim() === ""
    ? null
    : parseBody(result.stdout, endpoint);
}

const STATE_BY_MR_STATE = {
  opened: "OPEN",
  closed: "CLOSED",
  merged: "MERGED",
} as const satisfies Record<string, LandingRecord["state"]>;

interface MergeRequestBase {
  readonly id: number;
  readonly headSha: string;
  readonly targetBranch: string;
  readonly autoMerge: boolean;
}

/** What shipping needs from a merge request. Only a settled one has a diff start and only a merged one has a merge commit. */
export type MergeRequestFacts =
  | (MergeRequestBase & { readonly state: "OPEN" })
  | (MergeRequestBase & {
      readonly state: "CLOSED";
      readonly diffStartSha: string;
    })
  | (MergeRequestBase & {
      readonly state: "MERGED";
      readonly diffStartSha: string;
      readonly mergeCommitSha: string | null;
    });

export function parseMergeRequest(
  value: unknown,
  context: PrContext
): MergeRequestFacts {
  const mr = object(value, "merge request");
  const iid = prNumberField(mr.iid, "merge request.iid");
  if (iid !== context.number)
    invalid(`GitLab returned merge request !${iid} for !${context.number}`);
  const state = oneOf(
    mr.state,
    ["opened", "closed", "merged", "locked"] as const,
    "merge request.state"
  );
  if (state === "locked")
    return transient("GitLab has locked the merge request while it merges it");
  const base = {
    id: positiveInteger(mr.id, "merge request.id"),
    headSha: objectId(mr.sha, "merge request.sha"),
    targetBranch: text(mr.target_branch, "merge request.target_branch"),
    autoMerge: flag(
      mr.merge_when_pipeline_succeeds,
      "merge request.merge_when_pipeline_succeeds"
    ),
  };
  const landing = STATE_BY_MR_STATE[state];
  if (landing === "OPEN") return { ...base, state: "OPEN" };
  if (mr.diff_refs === null || mr.diff_refs === undefined)
    return invalid(
      `GitLab reports no diff_refs for this ${state} merge request, so its base commit is unknown`
    );
  const diffStartSha = objectId(
    object(mr.diff_refs, "merge request.diff_refs").start_sha,
    "diff_refs.start_sha"
  );
  if (landing === "CLOSED") return { ...base, state: "CLOSED", diffStartSha };
  return {
    ...base,
    state: "MERGED",
    diffStartSha,
    mergeCommitSha:
      mr.merge_commit_sha === null
        ? null
        : objectId(mr.merge_commit_sha, "merge request.merge_commit_sha"),
  };
}

/** Merge trains exist only on a Premium or Ultimate server. `enterprise:false` is the proof that a server has none, where a 404 proves nothing. */
export type Edition = "community" | "enterprise";

export function parseEdition(value: unknown): Edition {
  return flag(object(value, "version").enterprise, "version.enterprise")
    ? "enterprise"
    : "community";
}

interface TrainCar {
  readonly id: number;
  readonly mergeRequestId: number;
}

function parseTrainCar(value: unknown): TrainCar {
  const car = object(value, "merge train car");
  return {
    id: positiveInteger(car.id, "merge train car.id"),
    mergeRequestId: positiveInteger(
      object(car.merge_request, "merge train car.merge_request").id,
      "merge train car.merge_request.id"
    ),
  };
}

const TRAIN_PAGE_LIMIT = 10;

export class GlabShippingService implements ShippingService {
  private readonly project: ProjectRef;
  private readonly iids = new Map<string, PrNumber>();
  private edition: Promise<Edition> | undefined;

  constructor(
    project: ProjectRef,
    private readonly exec: GlabExec
  ) {
    if (!isHostname(project.host) || !isProjectPath(project.path))
      throw new ForgeError(
        "unparseable-remote",
        "the GitLab project is not a host and a group/project path"
      );
    this.project = { host: project.host.toLowerCase(), path: project.path };
  }

  private api(endpoint: string, request?: GlabRequest): Promise<unknown> {
    return glabApiJson(this.exec, this.project.host, endpoint, request);
  }

  private get projectEndpoint(): string {
    return `projects/${encodeURIComponent(this.project.path)}`;
  }

  private readEdition(): Promise<Edition> {
    this.edition ??= this.api("version").then(
      parseEdition,
      (error: unknown) => {
        this.edition = undefined;
        throw error;
      }
    );
    return this.edition;
  }

  private async baseOid(facts: MergeRequestFacts): Promise<string> {
    if (facts.state !== "OPEN") return facts.diffStartSha;
    const branch = object(
      await this.api(
        `${this.projectEndpoint}/repository/branches/${encodeURIComponent(facts.targetBranch)}`
      ),
      "target branch"
    );
    return objectId(
      object(branch.commit, "target branch.commit").id,
      "target branch.commit.id"
    );
  }

  private async queueEntryId(
    edition: Edition,
    facts: MergeRequestFacts
  ): Promise<string | null> {
    if (edition === "community") return null;
    const cars = await readPages(
      (next) => this.api(next),
      `${this.projectEndpoint}/merge_trains?scope=active`,
      TRAIN_PAGE_LIMIT
    );
    const car = cars
      .map(parseTrainCar)
      .find((c) => c.mergeRequestId === facts.id);
    return car === undefined ? null : String(car.id);
  }

  async inspect(context: PrContext): Promise<LandingRecord> {
    if (
      context.host.toLowerCase() !== this.project.host ||
      context.path.toLowerCase() !== this.project.path.toLowerCase()
    )
      throw new WatcherQueryError({
        kind: "invalid-context-url",
        retryable: false,
        rawValue: `${context.host}/${context.path}`,
        detail: `the merge request belongs to ${context.host}/${context.path}, not to ${this.project.host}/${this.project.path}, which this service was authorized for`,
      });
    const [raw, edition] = await Promise.all([
      this.api(`${this.projectEndpoint}/merge_requests/${context.number}`),
      this.readEdition(),
    ]);
    const facts = parseMergeRequest(raw, context);
    const [baseRefOid, queueEntryId] = await Promise.all([
      this.baseOid(facts),
      this.queueEntryId(edition, facts),
    ]);
    this.iids.set(String(facts.id), context.number);
    return {
      revision: {
        context,
        headRefOid: facts.headSha,
        baseRefName: facts.targetBranch,
        baseRefOid,
      },
      pullRequestId: String(facts.id),
      state: facts.state,
      pending: { autoMerge: facts.autoMerge, queueEntryId },
      mergeCommitOid: facts.state === "MERGED" ? facts.mergeCommitSha : null,
    };
  }

  /** The response is not trusted: a 2xx can mean nothing was cancelled, so `cancelPending` reads the merge request again. */
  private async cancel(pullRequestId: string): Promise<void> {
    const iid = this.iids.get(pullRequestId);
    if (iid === undefined)
      throw new WatcherQueryError({
        kind: "forge-unavailable",
        retryable: false,
        code: "not-inspected",
        detail: `merge request ${pullRequestId} was not inspected by this service, so it is not changed`,
      });
    object(
      await this.api(
        `${this.projectEndpoint}/merge_requests/${iid}/cancel_merge_when_pipeline_succeeds`,
        { method: "POST" }
      ),
      "cancel response"
    );
  }

  async disableAutoMerge(pullRequestId: string): Promise<void> {
    await this.cancel(pullRequestId);
  }

  /** GitLab takes a merge request off its merge train through the same endpoint that cancels auto-merge. */
  async dequeue(pullRequestId: string): Promise<void> {
    await this.cancel(pullRequestId);
  }
}

/** The host must be one `glab auth status` lists, so a flag or a saved record cannot aim the glab token at another host. */
export async function resolveGlabProject(
  project: ProjectRef,
  options: { readonly glabTimeoutMs?: number } = {}
): Promise<ProjectRef> {
  const forge = resolveForge(
    `https://${project.host}/${project.path}`,
    await detectForgeEnv(project.host.toLowerCase(), options)
  );
  if (forge.kind !== "gitlab")
    throw new ForgeError(
      "unsupported-forge",
      `${forge.project.host} resolves to the ${forge.kind} forge, which ship-pr does not serve through glab`
    );
  return { host: project.host.toLowerCase(), path: project.path };
}

export interface MergeNow {
  readonly context: PrContext;
  readonly headSha: string;
  readonly squash?: boolean;
}

/** The only builder of a merge command. It passes the head sha GitLab must match and turns glab's default auto-merge off, so the merge happens now or is refused. */
export function glabMergeArgv({
  context,
  headSha,
  squash = false,
}: MergeNow): readonly [string, ...string[]] {
  if (!isHostname(context.host) || !isProjectPath(context.path))
    invalid("the merge request is not on a host and a group/project path");
  return [
    "glab",
    "mr",
    "merge",
    String(context.number),
    "--repo",
    `https://${context.host}/${context.path}`,
    "--sha",
    objectId(headSha, "head sha"),
    "--auto-merge=false",
    "--yes",
    ...(squash ? ["--squash"] : []),
  ];
}
