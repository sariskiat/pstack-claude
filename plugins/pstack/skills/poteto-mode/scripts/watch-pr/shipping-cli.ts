import { readFile } from "node:fs/promises";
import { Command, CommanderError } from "commander";
import { GITHUB_HOST } from "../forge/forge.ts";
import { WatchDeadline } from "./deadline.ts";
import { run, runJson } from "./github.ts";
import { object, parseContext, wireReplacer } from "./landing.ts";
import {
  GhShippingService,
  cancelPending,
  inspectLanding,
  parseLandingRecord,
  type ShippingResult,
  type ShippingService,
} from "./shipping.ts";
import { GlabShippingService, resolveGlabProject } from "./shipping-gitlab.ts";
import type { PrContext } from "./types.ts";

async function serviceFor(
  context: PrContext,
  deadline: WatchDeadline
): Promise<ShippingService> {
  if (context.host === GITHUB_HOST)
    return new GhShippingService((args) => runJson(args, deadline));
  return new GlabShippingService(await resolveGlabProject(context), (argv) =>
    run(argv, deadline)
  );
}

export async function main(argv: readonly string[]): Promise<number> {
  let result: ShippingResult | undefined;
  const deadline = new WatchDeadline(60, () => performance.now() / 1000);
  const cli = new Command("ship-pr").exitOverride();
  cli.description(
    "Inspect a landing record or cancel its pending merge mechanisms. Never merges or rewrites branches."
  );
  cli
    .command("inspect")
    .requiredOption(
      "--repo <path>",
      "owner/repo on GitHub, or the group/project path on --host"
    )
    .requiredOption(
      "--pr <number>",
      "pull request number, or merge request iid on --host"
    )
    .option(
      "--host <host>",
      "a GitLab host you are logged in to; leave it out for github.com"
    )
    .action(async (options: { repo: string; pr: string; host?: string }) => {
      const host = options.host?.toLowerCase();
      let context: PrContext;
      if (host === undefined || host === GITHUB_HOST) {
        const parts = options.repo.split("/");
        if (parts.length !== 2) throw new Error("--repo must be owner/repo");
        context = parseContext({
          owner: parts[0],
          repo: parts[1],
          number: Number(options.pr),
        });
      } else
        context = parseContext({
          host,
          path: options.repo,
          number: Number(options.pr),
        });
      result = await inspectLanding(
        await serviceFor(context, deadline),
        context
      );
    });
  cli
    .command("cancel-pending")
    .requiredOption(
      "--record <file>",
      "JSON output from inspect or a successful cancellation"
    )
    .action(async (options: { record: string }) => {
      const input = object(
        JSON.parse(await readFile(options.record, "utf8")),
        "saved inspection"
      );
      if (input.kind !== "inspected" && input.kind !== "cancelled")
        throw new Error(
          "record must contain a successful inspection or cancellation"
        );
      const expected = parseLandingRecord(input.record);
      result = await cancelPending(
        await serviceFor(expected.revision.context, deadline),
        expected
      );
    });
  try {
    await cli.parseAsync(argv, { from: "user" });
    if (!result) return 64;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode === 0 ? 0 : 64;
    result = {
      kind: "unavailable",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  process.stdout.write(`${JSON.stringify(result, wireReplacer)}\n`);
  return result.kind === "inspected" || result.kind === "cancelled" ? 0 : 1;
}
