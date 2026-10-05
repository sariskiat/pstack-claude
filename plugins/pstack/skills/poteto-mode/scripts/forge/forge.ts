export type ForgeKind = "github" | "gitlab" | "origin";

/** A hosted project. `path` holds every group segment, so `a/b/c` is valid on GitLab. */
export interface ProjectRef {
  readonly host: string;
  readonly path: string;
}

export interface ForgeEnv {
  readonly gitlabHosts: readonly string[];
  readonly originOnPath: boolean;
}

export interface ResolvedForge {
  readonly kind: ForgeKind;
  readonly project: ProjectRef;
}

export type ForgeErrorCode =
  | "no-origin-remote"
  | "not-owner-repo"
  | "unparseable-remote"
  | "unknown-host";

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

function projectPath(raw: string): string | null {
  const parts = raw.split("/").filter(Boolean);
  if (parts.length === 0) return null;
  parts[parts.length - 1] = parts[parts.length - 1].replace(/\.git$/, "");
  return parts.length >= 2 && parts.every(Boolean) ? parts.join("/") : null;
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
    if (scp === null || path === null) throw unparseable();
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
  let decoded: string;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    throw unparseable();
  }
  const path = projectPath(decoded);
  if (path === null || url.hostname === "") throw unparseable();
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
  throw new ForgeError(
    "unknown-host",
    `host ${project.host} is not github.com, not listed by glab auth status, and no origin CLI is on PATH`
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
      `${project.host}/${project.path} is not an owner/repo path`
    );
  return { owner: parts[0], name: parts[1] };
}

interface Capture {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const TIMED_OUT = 124;
export const GLAB_TIMEOUT_MS = 3000;

async function capture(
  argv: readonly string[],
  timeoutMs?: number
): Promise<Capture> {
  try {
    const child = Bun.spawn([...argv], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: process.env,
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
        child.kill("SIGKILL");
        resolve({ code: TIMED_OUT, stdout: "", stderr: "" });
      }, timeoutMs);
    });
    try {
      return await Promise.race([finished, expired]);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { code: 127, stdout: "", stderr: "" };
  }
}

/** `glab auth status` prints each configured host alone on an unindented line. */
export function parseGlabHosts(output: string): readonly string[] {
  return output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => /^[A-Za-z0-9][A-Za-z0-9.-]*(:\d+)?$/.test(line));
}

/** Runs `glab auth status` only when it can change the answer: not for github.com, not when origin wins. */
export async function detectForgeEnv(
  remoteHost: string,
  options: { readonly glabTimeoutMs?: number } = {}
): Promise<ForgeEnv> {
  const origin = await capture(["sh", "-c", "command -v origin"]);
  const originOnPath = origin.code === 0;
  if (originOnPath || remoteHost === GITHUB_HOST)
    return { gitlabHosts: [], originOnPath };
  const glab = await capture(
    ["glab", "auth", "status"],
    options.glabTimeoutMs ?? GLAB_TIMEOUT_MS
  );
  return {
    gitlabHosts: parseGlabHosts(`${glab.stdout}\n${glab.stderr}`),
    originOnPath,
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

export async function resolveCheckoutForge(
  cwd: string
): Promise<ResolvedForge> {
  const remote = await originRemoteUrl(cwd);
  const { host } = parseRemoteUrl(remote);
  return resolveForge(remote, await detectForgeEnv(host));
}
