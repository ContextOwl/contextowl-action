// Runs the configured sync surfaces in order and returns their results.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type Cowl, type KeyIdentity, describeError } from "../types.js";
import type { Logger } from "../logger.js";
import type { ResolvedConfig } from "../config.js";
import { type Surface, type SurfaceResult, emptyResult } from "./plan.js";
import { type ReviewState, pendingProposals } from "./review.js";
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

/** The warning when a run under review cannot read the pending proposals. */
export const PROPOSALS_UNREAD =
  "the action cannot read the pending proposals of the key. A change that the repository dropped before an editor approved it can stay in its proposal.";

/** How the writes of a run go to the server. */
interface WriteMode {
  /** The note for the reviewer, or undefined for a server that rejects it. */
  note?: string;
  /** Set when the changes of the key to live content wait for review. */
  review?: ReviewState;
}

/**
 * Read GET /api/v1/me. A server with the review of agent changes returns
 * writes and accepts the note. Older servers reject an unknown field in a
 * request body, so they get no note. The identity is a convenience, so an
 * error only drops the note. When the changes of the key wait for review,
 * the run also reads the pending proposals once. A dry run sends no writes,
 * so it reads no proposals.
 */
async function writeMode(
  cowl: Cowl,
  logger: Logger,
  cfg: ResolvedConfig,
  note: string | undefined,
): Promise<WriteMode> {
  let identity: KeyIdentity;
  try {
    identity = await cowl.identity();
  } catch {
    return {};
  }
  const mode: WriteMode = { note: identity.writes ? note : undefined };
  if (identity.writes !== "review") return mode;
  logger.info(REVIEW_HINT);
  if (cfg.dryRun) return mode;
  mode.review = { articlePublish: identity.permissions.includes("article.publish") };
  if (cfg.docs || cfg.changelog) {
    try {
      mode.review.pending = pendingProposals(await cowl.listProposals(cfg.workspace));
    } catch (err) {
      logger.warning(`${PROPOSALS_UNREAD} Server error: ${describeError(err)}`);
    }
  }
  return mode;
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

  const { note: sentNote, review } = await writeMode(cowl, logger, cfg, note);
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
          review,
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
          review,
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
