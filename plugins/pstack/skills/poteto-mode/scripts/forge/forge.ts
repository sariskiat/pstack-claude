export type ForgeKind = "github" | "gitlab" | "origin";

/** A hosted project. `path` holds every group segment, so `a/b/c` is valid on GitLab. */
export interface ProjectRef {
  readonly host: string;
  readonly path: string;
}

export interface ForgeEnv {
  readonly gitlabHosts: readonly string[];
  readonly originOnPath: boolean;
  readonly glabTimedOutAfterMs?: number;
}

export interface ResolvedForge {
  readonly kind: ForgeKind;
  readonly project: ProjectRef;
}

export type ForgeErrorCode =
  | "no-origin-remote"
  | "not-owner-repo"
  | "unparseable-remote"
  | "unknown-host"
  | "not-github-host"
  | "glab-timeout"
  | "unsupported-forge";

export class ForgeError extends Error {
  constructor(
    readonly code: ForgeErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ForgeError";
  }
}

const SCP_REMOTE = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/;
export const GITHUB_HOST = "github.com";

const HOSTNAME =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/;
const PATH_SEGMENT = /^[\w.][\w.-]*$/;
const RESERVED_SEGMENTS: readonly string[] = [".", "..", ".git"];

export const isHostname = (host: string): boolean => HOSTNAME.test(host);

export const isPathSegment = (segment: string): boolean =>
  PATH_SEGMENT.test(segment) && !RESERVED_SEGMENTS.includes(segment);

export const isProjectPath = (path: string): boolean => {
  const segments = path.split("/");
  return segments.length >= 2 && segments.every(isPathSegment);
};

function projectPath(raw: string): string | null {
  const parts = raw.split("/").filter(Boolean);
  if (parts.length === 0) return null;
  parts[parts.length - 1] = parts[parts.length - 1].replace(/\.git$/, "");
  const path = parts.join("/");
  return isProjectPath(path) ? path : null;
}

function unparseable(): ForgeError {
  return new ForgeError(
    "unparseable-remote",
    "the origin remote URL is not an https, ssh, or scp-style git remote with a project path"
  );
}

/** Parses an https, ssh, or scp-style remote. Credentials never reach the result or an error. */
export function parseRemoteUrl(remoteUrl: string): ProjectRef {
  const value = remoteUrl.trim();
  if (!value.includes("://")) {
    const scp = SCP_REMOTE.exec(value);
    const path = scp === null ? null : projectPath(scp[2]);
    if (scp === null || path === null || !isHostname(scp[1]))
      throw unparseable();
    return { host: scp[1].toLowerCase(), path };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw unparseable();
  }
  const web = url.protocol === "https:" || url.protocol === "http:";
  if (!web && url.protocol !== "ssh:") throw unparseable();
  if (/%2f/i.test(url.pathname)) throw unparseable();
  let decoded: string;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    throw unparseable();
  }
  const path = projectPath(decoded);
  if (path === null || !isHostname(url.hostname)) throw unparseable();
  return { host: url.hostname.toLowerCase(), path };
}

const withoutPort = (host: string): string =>
  host.toLowerCase().replace(/:\d+$/, "");

/** Origin wins when its CLI is installed, then a host `glab` lists, then github.com. */
export function resolveForge(remoteUrl: string, env: ForgeEnv): ResolvedForge {
  const project = parseRemoteUrl(remoteUrl);
  if (env.originOnPath) return { kind: "origin", project };
  if (env.gitlabHosts.map(withoutPort).includes(project.host))
    return { kind: "gitlab", project };
  if (project.host === GITHUB_HOST) return { kind: "github", project };
  if (env.glabTimedOutAfterMs !== undefined)
    throw new ForgeError(
      "glab-timeout",
      `glab did not answer within ${env.glabTimedOutAfterMs / 1000} s, so ${project.host} could not be checked. The network or the VPN is the likely cause. Reconnect, then run the command again.`
    );
  throw new ForgeError(
    "unknown-host",
    `host ${project.host} is not github.com, not listed by glab auth status, and no origin CLI is on PATH. For a GitLab host, run: glab auth login --hostname ${project.host}`
  );
}

export function ownerAndName(project: ProjectRef): {
  readonly owner: string;
  readonly name: string;
} {
  const parts = project.path.split("/");
  if (parts.length !== 2 || parts.some((part) => part === ""))
    throw new ForgeError(
      "not-owner-repo",
      "the project path is not an owner/repo path"
    );
  return { owner: parts[0], name: parts[1] };
}

export function requireGithub(project: ProjectRef): ProjectRef {
  if (project.host !== GITHUB_HOST)
    throw new ForgeError(
      "not-github-host",
      "this project is not on github.com, so the GitHub reader cannot serve it"
    );
  return project;
}

export const githubOwnerAndName = (
  project: ProjectRef
): ReturnType<typeof ownerAndName> => ownerAndName(requireGithub(project));

export interface Capture {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const TIMED_OUT = 124;
export const NOT_INSTALLED = 127;

function killGroup(child: {
  readonly pid: number;
  kill(signal: "SIGKILL"): void;
}): void {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}
export const GLAB_TIMEOUT_MS = 10_000;

export async function capture(
  argv: readonly string[],
  timeoutMs?: number,
  cwd?: string
): Promise<Capture> {
  try {
    const child = Bun.spawn([...argv], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: process.env,
      detached: timeoutMs !== undefined,
      ...(cwd === undefined ? {} : { cwd }),
    });
    const finished = Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]).then(([stdout, stderr, code]) => ({ code, stdout, stderr }));
    if (timeoutMs === undefined) return await finished;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<Capture>((resolve) => {
      timer = setTimeout(() => {
        killGroup(child);
        resolve({ code: TIMED_OUT, stdout: "", stderr: "" });
      }, timeoutMs);
    });
    try {
      return await Promise.race([finished, expired]);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { code: NOT_INSTALLED, stdout: "", stderr: "" };
  }
}

/** `glab auth status` prints each configured host alone on an unindented line. */
export function parseGlabHosts(output: string): readonly string[] {
  return output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => /^[A-Za-z0-9][A-Za-z0-9.-]*(:\d+)?$/.test(line));
}

export async function detectForgeEnv(
  remoteHost: string,
  options: { readonly glabTimeoutMs?: number } = {}
): Promise<ForgeEnv> {
  const origin = await capture(["sh", "-c", "command -v origin"]);
  const originOnPath = origin.code === 0;
  if (originOnPath || remoteHost === GITHUB_HOST)
    return { gitlabHosts: [], originOnPath };
  const timeoutMs = options.glabTimeoutMs ?? GLAB_TIMEOUT_MS;
  const glab = await capture(["glab", "auth", "status"], timeoutMs);
  return {
    gitlabHosts: parseGlabHosts(`${glab.stdout}\n${glab.stderr}`),
    originOnPath,
    ...(glab.code === TIMED_OUT ? { glabTimedOutAfterMs: timeoutMs } : {}),
  };
}

export async function originRemoteUrl(cwd: string): Promise<string> {
  const result = await capture([
    "git",
    "-C",
    cwd,
    "remote",
    "get-url",
    "origin",
  ]);
  const url = result.stdout.trim();
  if (result.code !== 0 || url === "")
    throw new ForgeError(
      "no-origin-remote",
      "this checkout has no remote named origin"
    );
  return url;
}

export async function currentBranch(cwd: string): Promise<string | null> {
  const result = await capture([
    "git",
    "-C",
    cwd,
    "symbolic-ref",
    "--short",
    "-q",
    "HEAD",
  ]);
  const branch = result.stdout.trim();
  return result.code === 0 && branch !== "" ? branch : null;
}

/** A host glab lists is read through glab. Every other checkout goes to gh, as before GitLab support; `ifGhFails` keeps why the host is not GitLab, for when gh cannot find the repository either. */
export type CheckoutForge =
  | { readonly kind: "gitlab"; readonly project: ProjectRef }
  | { readonly kind: "github"; readonly ifGhFails: ForgeError | null };

export async function checkoutForge(
  cwd: string,
  options: { readonly glabTimeoutMs?: number } = {}
): Promise<CheckoutForge> {
  let remote: string;
  let host: string;
  try {
    remote = await originRemoteUrl(cwd);
    host = parseRemoteUrl(remote).host;
  } catch (error) {
    if (
      error instanceof ForgeError &&
      (error.code === "no-origin-remote" || error.code === "unparseable-remote")
    )
      return { kind: "github", ifGhFails: null };
    throw error;
  }
  if (host === GITHUB_HOST) return { kind: "github", ifGhFails: null };
  let forge: ResolvedForge;
  try {
    forge = resolveForge(remote, await detectForgeEnv(host, options));
  } catch (error) {
    if (error instanceof ForgeError)
      return { kind: "github", ifGhFails: error };
    throw error;
  }
  return forge.kind === "gitlab"
    ? { kind: "gitlab", project: forge.project }
    : {
        kind: "github",
        ifGhFails: new ForgeError(
          "unsupported-forge",
          `${forge.project.host} resolves to the ${forge.kind} forge, which this tool does not read`
        ),
      };
}

const GH_NO_GITHUB_REMOTE =
  "none of the git remotes configured for this repository point to a known GitHub host";
const GH_AUTH_REQUIRED = 4;

/** True when gh stopped before it found a GitHub repository: no remote it knows, no login, or no gh at all. */
export const ghFoundNoRepository = (code: number, firstLine: string): boolean =>
  code === GH_AUTH_REQUIRED ||
  code === NOT_INSTALLED ||
  firstLine.startsWith(GH_NO_GITHUB_REMOTE);

export const neitherForge = (
  whyNotGitLab: ForgeError,
  code: number,
  ghLine: string
): ForgeError =>
  new ForgeError(
    whyNotGitLab.code,
    `${whyNotGitLab.message} gh could not read the repository either: ${code === NOT_INSTALLED ? "gh is not installed" : ghLine || `gh exited ${code}`}`
  );

export async function resolveCheckoutForge(
  cwd: string
): Promise<ResolvedForge> {
  const remote = await originRemoteUrl(cwd);
  const { host } = parseRemoteUrl(remote);
  return resolveForge(remote, await detectForgeEnv(host));
}
