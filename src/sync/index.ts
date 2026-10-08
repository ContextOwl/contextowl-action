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
 * A stopped surface counts as one failed item, so the `failed` output is never
 * 0 for a surface that did not finish.
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
    r.failed = 1;
    r.failures.push(`${surface} sync stopped: ${describeError(err)}`);
    logger.error(`${surface}: sync stopped: ${describeError(err)}`);
  }
  r.lines.forEach((l) => logger.info(l));
  logger.endGroup();
  return r;
}

/** The hint for a key whose changes to live content wait for review. */
export const REVIEW_HINT =
  "The organization reviews agent changes, so changes to live content wait in Admin > Proposals until an editor approves them. To publish on merge, ask an admin to approve this key as a publishing key.";

/**
 * The note to send with each write that can wait for review. A server with
 * the review of agent changes returns writes from GET /api/v1/me and accepts
 * the note. Older servers reject an unknown field in a request body, so they
 * get no note. The identity is a convenience, so an error only drops the note.
 */
async function reviewNote(
  cowl: Cowl,
  logger: Logger,
  note: string | undefined,
): Promise<string | undefined> {
  let writes: string;
  try {
    writes = (await cowl.identity()).writes;
  } catch {
    return undefined;
  }
  if (writes === "review") logger.info(REVIEW_HINT);
  return writes ? note : undefined;
}

/**
 * Run the configured surfaces. `note` names the commit for the reviewer. The
 * surfaces send it only to a server that accepts it.
 */
export async function runSync(
  cowl: Cowl,
  logger: Logger,
  cfg: ResolvedConfig,
  root: string,
  note?: string,
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

  const sentNote = await reviewNote(cowl, logger, note);
  const results: SurfaceResult[] = [];

  if (docsDir) {
    results.push(
      await runSurface(logger, "docs", "Docs", () =>
        syncDocs(cowl, logger, {
          dir: docsDir,
          workspace: cfg.workspace,
          prune: cfg.prune,
          dryRun: cfg.dryRun,
          allowShrink: cfg.allowShrink,
          note: sentNote,
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
          note: sentNote,
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
          note: sentNote,
        }),
      ),
    );
  }

  return results;
}
