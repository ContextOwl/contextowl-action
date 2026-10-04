// Runs the configured sync surfaces in order and returns their results.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type Cowl, describeError } from "../types.js";
import type { Logger } from "../logger.js";
import type { ResolvedConfig } from "../config.js";
import { type Surface, type SurfaceResult, emptyResult } from "./plan.js";
import { syncDocs } from "./docs.js";
import { syncChangelog } from "./changelog.js";
import { syncOpenapi } from "./openapi.js";

/**
 * Run one surface inside a log group. An error that stops the surface becomes
 * part of its result, so the other surfaces still run and the summary shows it.
 */
async function runSurface(
  logger: Logger,
  surface: Surface,
  group: string,
  sync: () => Promise<SurfaceResult>,
): Promise<SurfaceResult> {
  logger.startGroup(group);
  let r: SurfaceResult;
  try {
    r = await sync();
  } catch (err) {
    r = emptyResult(surface);
    r.stopped = true;
    r.failures.push(`${surface} sync stopped: ${describeError(err)}`);
    logger.error(`${surface}: sync stopped: ${describeError(err)}`);
  }
  r.lines.forEach((l) => logger.info(l));
  logger.endGroup();
  return r;
}

export async function runSync(
  cowl: Cowl,
  logger: Logger,
  cfg: ResolvedConfig,
  root: string,
): Promise<SurfaceResult[]> {
  const docsDir = cfg.docs ? resolve(root, cfg.docs.dir) : undefined;
  const changelogFile = cfg.changelog ? resolve(root, cfg.changelog.file) : undefined;
  const openapiSpec = cfg.openapi ? resolve(root, cfg.openapi.spec) : undefined;

  // Preflight: fail before any writes if a configured path is missing.
  const missing: string[] = [];
  if (docsDir && !existsSync(docsDir)) missing.push(`docs.dir (${cfg.docs?.dir})`);
  if (changelogFile && !existsSync(changelogFile))
    missing.push(`changelog.file (${cfg.changelog?.file})`);
  if (openapiSpec && !existsSync(openapiSpec)) missing.push(`openapi.spec (${cfg.openapi?.spec})`);
  if (missing.length > 0) {
    throw new Error(`Configured path(s) not found: ${missing.join(", ")}`);
  }

  if (cfg.prune) {
    logger.warning(
      "prune is ON: articles absent from the repo will be DEPRECATED and changelog entries DELETED.",
    );
  }

  const results: SurfaceResult[] = [];

  if (docsDir) {
    results.push(
      await runSurface(logger, "docs", "Docs", () =>
        syncDocs(cowl, logger, {
          dir: docsDir,
          workspace: cfg.workspace,
          prune: cfg.prune,
          dryRun: cfg.dryRun,
        }),
      ),
    );
  }

  if (changelogFile) {
    results.push(
      await runSurface(logger, "changelog", "Changelog", () =>
        syncChangelog(cowl, logger, {
          file: changelogFile,
          workspace: cfg.workspace,
          prune: cfg.prune,
          dryRun: cfg.dryRun,
        }),
      ),
    );
  }

  if (openapiSpec) {
    results.push(
      await runSurface(logger, "openapi", "OpenAPI", () =>
        syncOpenapi(cowl, logger, {
          spec: openapiSpec,
          workspace: cfg.workspace,
          dryRun: cfg.dryRun,
        }),
      ),
    );
  }

  return results;
}
