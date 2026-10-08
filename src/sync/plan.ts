// Result accounting shared by all three sync surfaces.
import type { PendingReview } from "../types.js";

export type Surface = "docs" | "changelog" | "openapi";

/** A proposal that waits for review, and the item whose write filed it. */
export interface ProposedChange {
  /** The article title or the changelog version in quotes, or "OpenAPI spec". */
  item: string;
  review: PendingReview;
}

export interface SurfaceResult {
  surface: Surface;
  created: number;
  updated: number;
  deleted: number; // deletions, plus docs deprecations under prune
  skipped: number;
  /** Items that failed to sync. A stopped surface counts as one failed item. */
  failed: number;
  /** Items with a change that waits for review. Such an item counts in no other total. */
  proposed: number;
  warnings: string[];
  /** One message per failed item, plus the error that stopped the surface. */
  failures: string[];
  /** The proposals that wait for review, one per proposal. */
  proposals: ProposedChange[];
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
    proposed: 0,
    warnings: [],
    failures: [],
    proposals: [],
    stopped: false,
    lines: [],
  };
}

export interface Totals {
  created: number;
  updated: number;
  deleted: number;
  skipped: number;
  failed: number;
  proposed: number;
}

export function totals(results: SurfaceResult[]): Totals {
  return results.reduce(
    (acc, r) => ({
      created: acc.created + r.created,
      updated: acc.updated + r.updated,
      deleted: acc.deleted + r.deleted,
      skipped: acc.skipped + r.skipped,
      failed: acc.failed + r.failed,
      proposed: acc.proposed + r.proposed,
    }),
    { created: 0, updated: 0, deleted: 0, skipped: 0, failed: 0, proposed: 0 },
  );
}

/** "1 item", "2 items": a count with its noun. */
export function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * Count one item with a change that waits for review, and add one line for
 * each of its proposals. Two writes for one item can update one proposal, so
 * each proposal keeps the answer to the last write, which names all changes.
 */
export function addProposed(
  result: SurfaceResult,
  item: string,
  reviews: readonly PendingReview[],
): void {
  result.proposed++;
  for (const review of latestById(reviews)) {
    const proposal = { item, review };
    result.proposals.push(proposal);
    result.lines.push(proposalLine(proposal));
  }
}

function latestById(reviews: readonly PendingReview[]): PendingReview[] {
  const out: PendingReview[] = [];
  const index = new Map<number, number>();
  for (const review of reviews) {
    const at = review.id > 0 ? index.get(review.id) : undefined;
    if (at !== undefined) {
      out[at] = review;
      continue;
    }
    if (review.id > 0) index.set(review.id, out.length);
    out.push(review);
  }
  return out;
}

/**
 * The log line of a proposal, such as
 * `"Intro": Publish intro: DRAFT to STABLE. Proposal 42 waits for review: <review URL>`.
 */
export function proposalLine({ item, review }: ProposedChange): string {
  const where = review.reviewUrl ? `: ${review.reviewUrl}` : " in Admin > Proposals";
  return `${item}: ${proposalLead(review)}${where}`;
}

/** The job summary line of a proposal: the log line as HTML, with the review URL as a link. */
export function proposalHtml({ item, review }: ProposedChange): string {
  const url = review.reviewUrl;
  let where = " in Admin &gt; Proposals";
  if (/^https?:\/\//i.test(url)) {
    where = `: <a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`;
  } else if (url) {
    where = `: ${escapeHtml(url)}`;
  }
  return `${escapeHtml(item)}: ${escapeHtml(proposalLead(review))}${where}`;
}

/** "Publish intro: DRAFT to STABLE. Proposal 42 waits for review" */
function proposalLead(review: PendingReview): string {
  const text = `${review.id > 0 ? `proposal ${review.id}` : "the change"} waits for review`;
  if (!review.summary) return text;
  return `${review.summary}. ${text[0].toUpperCase()}${text.slice(1)}`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The rows of the summary table: the header, one row per surface, and the
 * totals. The Proposed column shows only when a change waits for review.
 */
export function summaryTable(results: SurfaceResult[]): string[][] {
  const t = totals(results);
  const proposed = t.proposed > 0;
  const row = (name: string, c: Totals): string[] => [
    name,
    String(c.created),
    String(c.updated),
    ...(proposed ? [String(c.proposed)] : []),
    String(c.deleted),
    String(c.skipped),
    String(c.failed),
  ];
  return [
    [
      "Surface",
      "Created",
      "Updated",
      ...(proposed ? ["Proposed"] : []),
      "Removed",
      "Unchanged",
      "Failed",
    ],
    ...results.map((r) => row(r.stopped ? `${r.surface} (stopped)` : r.surface, r)),
    row("total", t),
  ];
}

/** The last log line of a run. It names the proposed items only when a change waits for review. */
export function totalsLine(results: SurfaceResult[], dryRun: boolean): string {
  const t = totals(results);
  const warnings = results.reduce((n, r) => n + r.warnings.length, 0);
  const parts = [
    `${t.created} created`,
    `${t.updated} updated`,
    ...(t.proposed > 0 ? [`${t.proposed} proposed`] : []),
    `${t.deleted} removed`,
    `${t.skipped} unchanged`,
    `${t.failed} failed`,
    ...(warnings > 0 ? [count(warnings, "warning")] : []),
  ];
  return `${dryRun ? "Planned" : "Applied"}: ${parts.join(", ")}`;
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
