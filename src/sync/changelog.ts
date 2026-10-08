// Syncs a Keep a Changelog file into a workspace's changelog entries.
//
// Identity: the version string is the entry title. The sync lists every
// existing entry, drafts included, page by page, and matches entries by title
// to recover their numeric id for update and delete. New entries publish when
// the key allows it, else stay draft. A key without changelog.update sees only
// live published entries, so the sync creates no entry that the next run
// cannot find. Prune is opt-in and hard-deletes entries whose version is
// absent from the file.
import { existsSync, readFileSync } from "node:fs";
import type { Cowl, PendingReview, RemoteChangelog, UpdateChangelogArgs } from "../types.js";
import { CowlAPIError, describeError } from "../types.js";
import type { Logger } from "../logger.js";
import { type SurfaceResult, addProposed, emptyResult } from "./plan.js";
import { type ReviewState, changelogTitleKey } from "./review.js";
import { type ParsedChangelogEntry, parseChangelog } from "../util/changelog.js";

export interface ChangelogSyncOptions {
  file: string;
  workspace: string | undefined;
  prune: boolean;
  dryRun: boolean;
  /** Note for the reviewer on each write that can wait for review. */
  note?: string;
  /** Set when the changes of the key to live content wait for review. */
  review?: ReviewState;
}

/** Entries per list request: the largest page the server allows. */
export const CHANGELOG_PAGE_SIZE = 100;

/** Servers before the paging contract return at most this many entries and ignore `offset`. */
const LEGACY_LIST_CAP = 50;

const SECTION_NAMES = "Added, Changed, Deprecated, Removed, Fixed and Security";

const HIDDEN_DRAFT =
  "the key lacks changelog.publish and changelog.update. The next run cannot find a draft, so the action does not create one. Add one of the two permissions to the key.";

const HIDDEN_SCHEDULED =
  "the date is in the future, and the key lacks changelog.update. The next run cannot find a scheduled entry, so the action waits for a run after that date. To create it now, add changelog.update to the key.";

function tagsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

function sameInstant(a: string | undefined, b: string | null): boolean {
  if (!a) return true; // no desired date -> never a reason to change
  if (!b) return false;
  return new Date(a).getTime() === new Date(b).getTime();
}

function isFuture(date: string | undefined): boolean {
  return date !== undefined && new Date(date).getTime() > Date.now();
}

function firstFew(items: readonly string[]): string {
  const shown = items.slice(0, 3).join(", ");
  return items.length > 3 ? `${shown} and ${items.length - 3} more` : shown;
}

/**
 * List every remote entry. Pages with `limit` and `offset` until a page holds
 * fewer than CHANGELOG_PAGE_SIZE entries. A page of exactly LEGACY_LIST_CAP
 * entries can be the capped list of an older server, so the next page is read
 * too. A page that adds no new entry means the server ignores `offset`. The
 * list is then incomplete, so this throws instead of letting the sync create
 * duplicates.
 */
export async function listAllChangelog(
  cowl: Cowl,
  workspace: string | undefined,
  drafts: boolean,
): Promise<RemoteChangelog[]> {
  const entries: RemoteChangelog[] = [];
  const seen = new Set<number>();
  for (let offset = 0; ;) {
    const page = await cowl.listChangelog(workspace, {
      drafts,
      limit: CHANGELOG_PAGE_SIZE,
      offset,
    });
    let added = 0;
    for (const e of page) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      entries.push(e);
      added++;
    }
    if (page.length > 0 && added === 0) {
      throw new Error(
        `the changelog list repeats the entries of an earlier page at offset ${offset}. The server does not support offset paging. The action stops before any change, because an incomplete list causes duplicate entries.`,
      );
    }
    if (page.length < CHANGELOG_PAGE_SIZE && page.length !== LEGACY_LIST_CAP) return entries;
    offset += page.length;
  }
}

export async function syncChangelog(
  cowl: Cowl,
  logger: Logger,
  opts: ChangelogSyncOptions,
): Promise<SurfaceResult> {
  const result = emptyResult("changelog");
  const warn = (m: string) => {
    result.warnings.push(m);
    logger.warning(`changelog: ${m}`);
  };
  const fail = (m: string) => {
    result.failed++;
    result.failures.push(m);
    logger.warning(`changelog: ${m}`);
  };

  if (!existsSync(opts.file)) throw new Error(`changelog.file not found: ${opts.file}`);

  const parsed = parseChangelog(readFileSync(opts.file, "utf8"));
  if (parsed.length === 0) {
    warn(`no versioned entries in ${opts.file}`);
    return result;
  }

  const desired: ParsedChangelogEntry[] = [];
  const versions = new Set<string>();
  for (const d of parsed) {
    const key = d.version.toLowerCase();
    if (versions.has(key)) {
      warn(`version "${d.version}" appears more than once. The action syncs the first one.`);
      continue;
    }
    versions.add(key);
    desired.push(d);
  }

  const unmapped = new Map<string, { name: string; versions: string[] }>();
  for (const d of desired) {
    for (const name of d.unmapped) {
      const group = unmapped.get(name.toLowerCase()) ?? { name, versions: [] };
      group.versions.push(d.version);
      unmapped.set(name.toLowerCase(), group);
    }
  }
  for (const { name, versions: where } of unmapped.values()) {
    warn(
      `"### ${name}" maps to no tag, so the action sends no tag for it in ${firstFew(where)}. Tags come from ${SECTION_NAMES}.`,
    );
  }

  let remote: RemoteChangelog[];
  let draftsHidden = false;
  try {
    remote = await listAllChangelog(cowl, opts.workspace, true);
  } catch (err) {
    if (!(err instanceof CowlAPIError && err.isPermissionDenied())) throw err;
    remote = await listAllChangelog(cowl, opts.workspace, false);
    draftsHidden = true;
    warn(
      "the key lacks changelog.update, so the action sees only published entries. A version that exists only as a draft or a scheduled entry can get a second entry. Add changelog.update to the key.",
    );
  }
  const byTitle = new Map<string, RemoteChangelog>();
  for (const e of remote) {
    const key = e.title.toLowerCase();
    if (!byTitle.has(key)) byTitle.set(key, e);
  }

  const claimed = new Set<number>();
  let publishDenied = false;
  const denyPublish = () => {
    if (publishDenied) return;
    publishDenied = true;
    if (!draftsHidden) {
      warn(
        "the key lacks changelog.publish, so new entries stay drafts and the action does not publish drafts.",
      );
    }
  };

  // A published entry that waits for review does not exist until an editor
  // approves it. The next run sends the create again, and the server keeps
  // one proposal for the title, so the approval creates one entry.
  const create = async (d: ParsedChangelogEntry): Promise<void> => {
    const base = {
      title: d.version,
      markdown: d.markdown,
      tags: d.tags,
      publishedAt: d.publishedAt,
      note: opts.note,
    };
    if (publishDenied && draftsHidden) throw new Error(HIDDEN_DRAFT);
    let review: PendingReview | null;
    try {
      review = await cowl.createChangelog(opts.workspace, {
        ...base,
        status: publishDenied ? "draft" : "published",
      });
    } catch (err) {
      if (!(err instanceof CowlAPIError && err.isPermissionDenied("changelog.publish"))) {
        throw err;
      }
      denyPublish();
      if (draftsHidden) throw new Error(HIDDEN_DRAFT);
      review = await cowl.createChangelog(opts.workspace, base);
    }
    if (review) {
      addProposed(result, `"${d.version}"`, [review]);
      return;
    }
    result.lines.push(`created "${d.version}"`);
    result.created++;
  };

  // Under review, an update changes the working copy of the key, and a field
  // that the update leaves out keeps its value there. So the update of an
  // entry with a pending proposal of the key sends the full entry from the
  // file. A field that the file does not set, or that equals the live entry,
  // goes as the live value. Then the spaces around the text and the order of
  // the tags add no change.
  const fullEntry = (d: ParsedChangelogEntry, r: RemoteChangelog): UpdateChangelogArgs => ({
    id: r.id,
    note: opts.note,
    markdown: d.markdown.trim() === r.markdown.trim() ? r.markdown : d.markdown,
    tags: d.tags.length > 0 && !tagsEqual(d.tags, r.tags) ? d.tags : r.tags,
    publishedAt: d.publishedAt ?? r.publishedAt ?? undefined,
  });

  const update = async (d: ParsedChangelogEntry, r: RemoteChangelog): Promise<void> => {
    const patch: UpdateChangelogArgs = { id: r.id, note: opts.note };
    const reasons: string[] = [];
    if (d.markdown.trim() !== r.markdown.trim()) {
      patch.markdown = d.markdown;
      reasons.push("body");
    }
    if (d.tags.length > 0 && !tagsEqual(d.tags, r.tags)) {
      patch.tags = d.tags;
      reasons.push("tags");
    }
    if (!sameInstant(d.publishedAt, r.publishedAt)) {
      patch.publishedAt = d.publishedAt;
      reasons.push("date");
    }
    const wantPublish = r.status !== "published" && !publishDenied;
    // A pending proposal of the key from an earlier run can hold a change or
    // a delete that the file no longer has. An update with the entry from the
    // file brings it in line, or withdraws it when the entry equals the live
    // entry.
    const pending = opts.review?.pending?.entries.has(r.id) ?? false;

    if (reasons.length === 0 && !wantPublish && (opts.dryRun || !pending)) {
      result.skipped++;
      return;
    }
    if (opts.dryRun) {
      result.lines.push(
        `update "${d.version}" (${[...reasons, ...(wantPublish ? ["publish"] : [])].join(", ")})`,
      );
      result.updated++;
      return;
    }

    const send = pending ? fullEntry(d, r) : patch;
    if (wantPublish) send.status = "published";
    let review: PendingReview | null;
    try {
      review = await cowl.updateChangelog(opts.workspace, send);
    } catch (err) {
      if (!(
        err instanceof CowlAPIError &&
        err.isPermissionDenied("changelog.publish") &&
        send.status
      )) {
        throw err;
      }
      denyPublish();
      delete send.status;
      if (reasons.length === 0 && !pending) {
        result.skipped++;
        return;
      }
      review = await cowl.updateChangelog(opts.workspace, send);
    }
    if (review) {
      addProposed(result, `"${d.version}"`, [review]);
      return;
    }
    if (reasons.length === 0 && !(wantPublish && send.status)) {
      result.skipped++;
      return;
    }
    result.lines.push(`updated "${d.version}"`);
    result.updated++;
  };

  for (const d of desired) {
    const r = byTitle.get(d.version.toLowerCase());
    try {
      if (r) {
        claimed.add(r.id);
        await update(d, r);
      } else if (draftsHidden && isFuture(d.publishedAt)) {
        throw new Error(HIDDEN_SCHEDULED);
      } else if (opts.dryRun) {
        result.lines.push(`create "${d.version}"`);
        result.created++;
      } else {
        await create(d);
      }
    } catch (err) {
      fail(`entry "${d.version}" failed: ${describeError(err)}`);
    }
  }

  // No write withdraws a pending create, so a version that the file dropped
  // after its create waited stays until an editor rejects it.
  const fileTitles = new Set(desired.map((d) => changelogTitleKey(d.version)));
  for (const { id, title } of opts.review?.pending?.creates ?? []) {
    if (fileTitles.has(changelogTitleKey(title))) continue;
    warn(
      `proposal ${id} creates the entry "${title}", but the changelog file has no such version. The action cannot withdraw a pending create. If the file dropped the version, reject proposal ${id} in Admin > Proposals.`,
    );
  }

  // Prune: delete entries whose version is no longer in the file.
  const orphans = remote.filter((e) => !claimed.has(e.id));
  if (orphans.length > 0 && !opts.prune) {
    logger.info(`changelog: ${orphans.length} entr(ies) not in repo (enable prune to delete)`);
  }
  if (opts.prune) {
    let deleteDenied = false;
    for (const e of orphans) {
      if (opts.dryRun) {
        result.lines.push(`delete "${e.title}"`);
        result.deleted++;
        continue;
      }
      if (deleteDenied) break;
      try {
        const review = await cowl.deleteChangelog(opts.workspace, e.id, opts.note);
        if (review) {
          addProposed(result, `"${e.title}"`, [review]);
          continue;
        }
        result.lines.push(`deleted "${e.title}"`);
        result.deleted++;
      } catch (err) {
        if (err instanceof CowlAPIError && err.isPermissionDenied()) {
          deleteDenied = true;
          warn(
            `prune stopped because the key lacks changelog.delete. Server error: ${describeError(err)}`,
          );
        } else {
          fail(`delete "${e.title}" failed: ${describeError(err)}`);
        }
      }
    }
  }

  return result;
}
