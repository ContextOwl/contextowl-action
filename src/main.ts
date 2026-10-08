// GitHub Action entrypoint: read inputs, connect to ContextOwl, run the sync,
// and report results as a job summary and outputs.
import { resolve } from "node:path";
import * as core from "@actions/core";
import { type ActionInputs, resolveConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { RestClient } from "./api/client.js";
import { commitNote } from "./note.js";
import { runSync } from "./sync/index.js";
import {
  type SurfaceResult,
  count,
  jobFailure,
  proposalHtml,
  summaryTable,
  totals,
  totalsLine,
} from "./sync/plan.js";

const logger: Logger = {
  info: (m) => core.info(m),
  warning: (m) => core.warning(m),
  error: (m) => core.error(m),
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
    failOnError: core.getBooleanInput("fail-on-error"),
    allowShrink: core.getBooleanInput("allow-shrink"),
  };

  const cfg = resolveConfig(inputs);
  core.info(`ContextOwl API: ${cfg.apiUrl}`);
  if (cfg.dryRun) core.info("Dry run: no changes will be made.");

  const results = await runSync(
    new RestClient(cfg.apiUrl, cfg.token),
    logger,
    cfg,
    root,
    commitNote(process.env),
  );

  const t = totals(results);
  core.setOutput("created", t.created);
  core.setOutput("updated", t.updated);
  core.setOutput("deleted", t.deleted);
  core.setOutput("skipped", t.skipped);
  core.setOutput("failed", t.failed);
  core.setOutput("proposed", t.proposed);

  await writeSummary(results, cfg.dryRun);
  core.info(totalsLine(results, cfg.dryRun));

  const failure = jobFailure(results, cfg.failOnError);
  if (failure) {
    core.setFailed(failure);
  } else if (t.failed > 0) {
    core.warning(
      `${count(t.failed, "item")} failed to sync. The job passes because fail-on-error is false.`,
    );
  }
}

async function writeSummary(results: SurfaceResult[], dryRun: boolean): Promise<void> {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  const [header, ...rows] = summaryTable(results);
  core.summary
    .addHeading(`ContextOwl ${dryRun ? "(dry run)" : "publish"}`, 2)
    .addTable([header.map((data) => ({ data, header: true })), ...rows]);
  const failures = results.flatMap((r) => r.failures);
  if (failures.length) {
    core.summary.addHeading("Failures", 3).addList(failures);
  }
  const proposals = results.flatMap((r) => r.proposals);
  if (proposals.length) {
    core.summary.addHeading("Waiting for review", 3).addList(proposals.map(proposalHtml));
  }
  const warnings = results.flatMap((r) => r.warnings);
  if (warnings.length) {
    core.summary.addHeading("Warnings", 3).addList(warnings);
  }
  await core.summary.write();
}

run().catch((err) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
