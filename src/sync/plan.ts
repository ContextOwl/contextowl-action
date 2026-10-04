// Result accounting shared by all three sync surfaces.
export type Surface = "docs" | "changelog" | "openapi";

export interface SurfaceResult {
  surface: Surface;
  created: number;
  updated: number;
  deleted: number; // deletions, plus docs deprecations under prune
  skipped: number;
  /** Items that failed to sync. A stopped surface counts as one failed item. */
  failed: number;
  warnings: string[];
  /** One message per failed item, plus the error that stopped the surface. */
  failures: string[];
  /** True when an error stopped the surface before it finished. */
  stopped: boolean;
  /** Human-readable "verb target" lines for the log and job summary. */
  lines: string[];
}

export function emptyResult(surface: Surface): SurfaceResult {
  return {
    surface,
    created: 0,
    updated: 0,
    deleted: 0,
    skipped: 0,
    failed: 0,
    warnings: [],
    failures: [],
    stopped: false,
    lines: [],
  };
}

export function totals(results: SurfaceResult[]) {
  return results.reduce(
    (acc, r) => ({
      created: acc.created + r.created,
      updated: acc.updated + r.updated,
      deleted: acc.deleted + r.deleted,
      skipped: acc.skipped + r.skipped,
      failed: acc.failed + r.failed,
    }),
    { created: 0, updated: 0, deleted: 0, skipped: 0, failed: 0 },
  );
}

/** "1 item", "2 items": a count with its noun. */
export function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * The reason to fail the job, or undefined when it passes. A stopped surface
 * always fails the job. Failed items fail it only when `failOnError` is true.
 */
export function jobFailure(results: SurfaceResult[], failOnError: boolean): string | undefined {
  const stopped = results.filter((r) => r.stopped).map((r) => r.surface);
  if (stopped.length > 0) {
    return `Sync stopped for ${stopped.join(", ")}. See the job summary.`;
  }
  const { failed } = totals(results);
  if (failed > 0 && failOnError) {
    return `${count(failed, "item")} failed to sync. See the job summary.`;
  }
  return undefined;
}
