import { WatcherQueryError } from "./github.ts";
import { GITHUB_HOST } from "../forge/forge.ts";
import { parsePrNumber, type PrContext } from "./types.ts";

export interface LandingRevision {
  readonly context: PrContext;
  readonly headRefOid: string;
  readonly baseRefName: string;
  readonly baseRefOid: string;
}

function invalid(detail: string): never {
  throw new WatcherQueryError({ kind: "missing-key", retryable: true, detail });
}

export function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
}

export function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0)
    invalid(`${label} must be a non-empty string`);
  return value;
}

export const nullableText = (value: unknown, label: string): string | null =>
  value === null ? null : text(value, label);

export function oneOf<const V extends readonly string[]>(
  value: unknown,
  values: V,
  label: string
): V[number] {
  for (const candidate of values) if (candidate === value) return candidate;
  return invalid(`missing or invalid ${label}`);
}

export function flag(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") invalid(`missing ${label}`);
  return value;
}

export function parseContext(value: unknown): PrContext {
  const fields = object(value, "PR context");
  if (fields.host !== undefined)
    return {
      host: text(fields.host, "host"),
      path: text(fields.path, "path"),
      number: parsePrNumber(fields.number),
    };
  const owner = text(fields.owner, "owner");
  const repo = text(fields.repo, "repo");
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo))
    invalid("owner and repo must be individual repository names");
  return {
    host: GITHUB_HOST,
    path: `${owner}/${repo}`,
    number: parsePrNumber(fields.number),
  };
}

function isPrContext(value: unknown): value is PrContext {
  if (typeof value !== "object" || value === null) return false;
  const fields = value as Record<string, unknown>;
  return (
    typeof fields.host === "string" &&
    typeof fields.path === "string" &&
    typeof fields.number === "number"
  );
}

export type WireContext =
  | { readonly owner: string; readonly repo: string; readonly number: number }
  | { readonly host: string; readonly path: string; readonly number: number };

export function contextToWire(context: PrContext): WireContext {
  const [owner, repo, ...rest] = context.path.split("/");
  return context.host === GITHUB_HOST && repo !== undefined && rest.length === 0
    ? { owner, repo, number: context.number }
    : { host: context.host, path: context.path, number: context.number };
}

/** JSON.stringify replacer that writes every PrContext in its wire shape. */
export const wireReplacer = (_key: string, value: unknown): unknown =>
  isPrContext(value) ? contextToWire(value) : value;

export function parseLandingRevision(
  value: unknown,
  context?: PrContext
): LandingRevision {
  const fields = object(value, "landing revision");
  return {
    context: context ?? parseContext(fields.context),
    headRefOid: text(fields.headRefOid, "headRefOid"),
    baseRefName: text(fields.baseRefName, "baseRefName"),
    baseRefOid: text(fields.baseRefOid, "baseRefOid"),
  };
}

export function landingRevision(source: LandingRevision): LandingRevision {
  const { context, headRefOid, baseRefName, baseRefOid } = source;
  return { context, headRefOid, baseRefName, baseRefOid };
}

export function sameLandingRevision(
  a: LandingRevision,
  b: LandingRevision
): boolean {
  return (
    a.context.host.toLowerCase() === b.context.host.toLowerCase() &&
    a.context.path.toLowerCase() === b.context.path.toLowerCase() &&
    a.context.number === b.context.number &&
    a.headRefOid === b.headRefOid &&
    a.baseRefName === b.baseRefName &&
    a.baseRefOid === b.baseRefOid
  );
}
