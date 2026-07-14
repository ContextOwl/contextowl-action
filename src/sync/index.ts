// Runs the configured sync surfaces in order and returns their results.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Cowl } from "../types.js";
import type { Logger } from "../logger.js";
import type { ResolvedConfig } from "../config.js";
import type { SurfaceResult } from "./plan.js";
import { syncDocs } from "./docs.js";
import { syncChangelog } from "./changelog.js";
import { syncOpenapi } from "./openapi.js";

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
    logger.startGroup("Docs");
    const r = await syncDocs(cowl, logger, {
      dir: docsDir,
      workspace: cfg.workspace,
      prune: cfg.prune,
      dryRun: cfg.dryRun,
    });
    r.lines.forEach((l) => logger.info(l));
    logger.endGroup();
    results.push(r);
  }

  if (changelogFile) {
    logger.startGroup("Changelog");
    const r = await syncChangelog(cowl, logger, {
      file: changelogFile,
      workspace: cfg.workspace,
      prune: cfg.prune,
      dryRun: cfg.dryRun,
    });
    r.lines.forEach((l) => logger.info(l));
    logger.endGroup();
    results.push(r);
  }

  if (openapiSpec) {
    logger.startGroup("OpenAPI");
    const r = await syncOpenapi(cowl, logger, {
      spec: openapiSpec,
      workspace: cfg.workspace,
      dryRun: cfg.dryRun,
    });
    r.lines.forEach((l) => logger.info(l));
    logger.endGroup();
    results.push(r);
  }

  return results;
}
