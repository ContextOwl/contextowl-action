// Attaches the repo's OpenAPI spec to the workspace, regenerating API pages.
// The server diffs and prunes generated pages itself and returns the counts.
import { existsSync, readFileSync, statSync } from "node:fs";
import type { Cowl } from "../types.js";
import { CowlAPIError, describeError } from "../types.js";
import type { Logger } from "../logger.js";
import { type SurfaceResult, emptyResult } from "./plan.js";

export interface OpenapiSyncOptions {
  spec: string;
  workspace: string | undefined;
  dryRun: boolean;
}

/** Why the server refused the attach, for a 402 or 403 answer. */
function skipReason(err: CowlAPIError): string {
  if (err.status === 402) return "the workspace plan does not include the OpenAPI reference";
  const permission = err.details.permission;
  return `the key lacks ${typeof permission === "string" ? permission : "openapi.attach"}`;
}

export async function syncOpenapi(
  cowl: Cowl,
  logger: Logger,
  opts: OpenapiSyncOptions,
): Promise<SurfaceResult> {
  const result = emptyResult("openapi");

  if (!existsSync(opts.spec)) throw new Error(`openapi.spec not found: ${opts.spec}`);
  const spec = readFileSync(opts.spec, "utf8");

  if (opts.dryRun) {
    result.lines.push(`attach OpenAPI spec ${opts.spec} (${statSync(opts.spec).size} bytes)`);
    return result;
  }

  try {
    const { stats, unchanged } = await cowl.attachOpenapi(opts.workspace, spec);
    if (unchanged) {
      result.skipped++;
      result.lines.push("OpenAPI spec unchanged: kept the generated pages");
    } else if (stats) {
      result.created = stats.created;
      result.updated = stats.updated;
      result.deleted = stats.deleted;
      result.lines.push(
        `synced OpenAPI: ${stats.created} created, ${stats.updated} updated, ${stats.deleted} removed`,
      );
    } else {
      result.lines.push("attached OpenAPI spec");
    }
  } catch (err) {
    if (err instanceof CowlAPIError && (err.status === 402 || err.status === 403)) {
      const message = `skipped the OpenAPI step because ${skipReason(err)}. Server error: ${describeError(err)}`;
      result.warnings.push(message);
      logger.warning(`openapi: ${message}`);
    } else {
      const message = `attach OpenAPI spec failed: ${describeError(err)}`;
      result.failed++;
      result.failures.push(message);
      logger.warning(`openapi: ${message}`);
    }
  }

  return result;
}
