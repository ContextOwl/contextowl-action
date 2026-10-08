// The review of agent changes. When the organization reviews agent changes,
// the server keeps one working copy of the key for each target: its pending
// proposal. A write of the key changes that working copy, not the live
// content. A field that the write leaves out keeps its value in the working
// copy, and a working copy that equals the live content withdraws the
// proposal. So for an item with a pending proposal, the sync sends the full
// repository state, also when the item equals the live content.
import type { RemoteProposal } from "../types.js";

/** The pending proposals at the start of the run, by the item that they change. */
export interface PendingProposals {
  /** Proposal ids of article changes and publish requests, by article slug. */
  articles: Map<string, number>;
  /** Proposal ids of moves, by article slug. */
  placements: Map<string, number>;
  /** Proposal ids of changelog changes and deletes, by entry id. */
  entries: Map<number, number>;
  /** Pending creates of published changelog entries. */
  creates: { id: number; title: string }[];
}

/**
 * The review state of a run whose key writes under review. The proposal
 * list holds the rows of every key of the key owner. A write of this key
 * never changes the proposal of another key, so the rows of other keys cost
 * one write that changes nothing.
 */
export interface ReviewState {
  /** The pending proposals, or undefined when the list failed. */
  pending?: PendingProposals;
  /** True when the key can use article.publish, so it can send a status. */
  articlePublish: boolean;
}

/**
 * Index the pending proposals of writes under review. A proposal that a
 * propose call filed has no target, and the sync never changes it.
 */
export function pendingProposals(rows: readonly RemoteProposal[]): PendingProposals {
  const pending: PendingProposals = {
    articles: new Map(),
    placements: new Map(),
    entries: new Map(),
    creates: [],
  };
  for (const row of rows) {
    if ((row.status && row.status !== "pending") || !row.target) continue;
    if (row.objectType === "article" && row.slug) {
      pending.articles.set(row.slug, row.id);
    } else if (row.objectType === "placement" && row.slug) {
      pending.placements.set(row.slug, row.id);
    } else if (row.objectType === "changelog") {
      const entry = /^changelog:(\d+)$/.exec(row.target);
      if (entry) {
        pending.entries.set(Number(entry[1]), row.id);
      } else if (row.target.startsWith("changelog-new:") && row.title) {
        pending.creates.push({ id: row.id, title: row.title });
      }
    }
  }
  return pending;
}

/** A changelog title as the server compares titles: lower case, single spaces. */
export function changelogTitleKey(title: string): string {
  return title.trim().toLowerCase().split(/\s+/).join(" ");
}
