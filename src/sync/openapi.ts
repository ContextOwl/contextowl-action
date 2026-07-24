// Attaches the repo's OpenAPI spec to the workspace, regenerating API pages.
// The server diffs and prunes generated pages itself and returns the counts.
import { existsSync, readFileSync, statSync } from "node:fs";
import type { Cowl } from "../types.js";
import { CowlAPIError } from "../types.js";
import type { Logger } from "../logger.js";
import { type SurfaceResult, emptyResult } from "./plan.js";

export interface OpenapiSyncOptions {
  spec: string;
  workspace: string | undefined;
  dryRun: boolean;
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
    const stats = await cowl.attachOpenapi(opts.workspace, spec);
    if (stats) {
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
    if (err instanceof CowlAPIError && err.isPermissionDenied("openapi.attach")) {
      result.warnings.push("token lacks openapi.attach; skipping OpenAPI sync");
      logger.warning("openapi: token lacks openapi.attach; skipping");
    } else {
      throw err;
    }
  }

  return result;
}
