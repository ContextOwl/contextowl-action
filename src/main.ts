// GitHub Action entrypoint: read inputs, connect to ContextOwl, run the sync,
// and report results as a job summary and outputs.
import { resolve } from "node:path";
import * as core from "@actions/core";
import { type ActionInputs, resolveConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { CowlClient } from "./mcp/client.js";
import { runSync } from "./sync/index.js";
import { totals } from "./sync/plan.js";

const logger: Logger = {
  info: (m) => core.info(m),
  warning: (m) => core.warning(m),
  startGroup: (n) => core.startGroup(n),
  endGroup: () => core.endGroup(),
};

async function run(): Promise<void> {
  const token = core.getInput("token", { required: true });
  core.setSecret(token);

  const root = process.env.GITHUB_WORKSPACE || process.cwd();
  const inputs: ActionInputs = {
    token,
    serverUrl: core.getInput("server-url"),
    configPath: resolve(root, core.getInput("config") || ".contextowl.yml"),
    workspace: core.getInput("workspace"),
    prune: core.getBooleanInput("prune"),
    dryRun: core.getBooleanInput("dry-run"),
  };

  const cfg = resolveConfig(inputs);
  core.info(`ContextOwl endpoint: ${cfg.mcpUrl}`);
  if (cfg.dryRun) core.info("Dry run: no changes will be made.");

  const client = new CowlClient(cfg.mcpUrl, cfg.token);
  await client.connect();

  let results;
  try {
    results = await runSync(client, logger, cfg, root);
  } finally {
    await client.close().catch(() => {});
  }

  const t = totals(results);
  core.setOutput("created", t.created);
  core.setOutput("updated", t.updated);
  core.setOutput("deleted", t.deleted);
  core.setOutput("skipped", t.skipped);

  const warnings = results.flatMap((r) => r.warnings);
  await writeSummary(results, cfg.dryRun);

  const verb = cfg.dryRun ? "Planned" : "Applied";
  core.info(
    `${verb}: ${t.created} created, ${t.updated} updated, ${t.deleted} removed, ${t.skipped} unchanged` +
      (warnings.length ? `, ${warnings.length} warning(s)` : ""),
  );
}

async function writeSummary(
  results: Awaited<ReturnType<typeof runSync>>,
  dryRun: boolean,
): Promise<void> {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  const t = totals(results);
  core.summary.addHeading(`ContextOwl ${dryRun ? "(dry run)" : "publish"}`, 2).addTable([
    [
      { data: "Surface", header: true },
      { data: "Created", header: true },
      { data: "Updated", header: true },
      { data: "Removed", header: true },
      { data: "Unchanged", header: true },
    ],
    ...results.map((r) => [
      r.surface,
      String(r.created),
      String(r.updated),
      String(r.deleted),
      String(r.skipped),
    ]),
    ["total", String(t.created), String(t.updated), String(t.deleted), String(t.skipped)],
  ]);
  const warnings = results.flatMap((r) => r.warnings);
  if (warnings.length) {
    core.summary.addHeading("Warnings", 3).addList(warnings);
  }
  await core.summary.write();
}

run().catch((err) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
