// Result accounting shared by all three sync surfaces.
export type Surface = "docs" | "changelog" | "openapi";

export interface SurfaceResult {
  surface: Surface;
  created: number;
  updated: number;
  deleted: number; // deletions, plus docs deprecations under prune
  skipped: number;
  warnings: string[];
  /** Human-readable "verb target" lines for the log and job summary. */
  lines: string[];
}

export function emptyResult(surface: Surface): SurfaceResult {
  return { surface, created: 0, updated: 0, deleted: 0, skipped: 0, warnings: [], lines: [] };
}

export function totals(results: SurfaceResult[]) {
  return results.reduce(
    (acc, r) => ({
      created: acc.created + r.created,
      updated: acc.updated + r.updated,
      deleted: acc.deleted + r.deleted,
      skipped: acc.skipped + r.skipped,
    }),
    { created: 0, updated: 0, deleted: 0, skipped: 0 },
  );
}
