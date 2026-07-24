// Syncs a Keep a Changelog file into a workspace's changelog entries.
//
// Identity: the version string is the entry title. Entries are matched against
// existing entries (drafts included) by title to recover their numeric id for
// update/delete. New entries publish when the token allows it, else stay draft.
// Prune (opt-in) hard-deletes entries whose version is absent from the file.
import { existsSync, readFileSync } from "node:fs";
import type { Cowl, RemoteChangelog } from "../types.js";
import { CowlAPIError } from "../types.js";
import type { Logger } from "../logger.js";
import { type SurfaceResult, emptyResult } from "./plan.js";
import { type ParsedChangelogEntry, parseChangelog } from "../util/changelog.js";

export interface ChangelogSyncOptions {
  file: string;
  workspace: string | undefined;
  prune: boolean;
  dryRun: boolean;
}

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

  if (!existsSync(opts.file)) throw new Error(`changelog.file not found: ${opts.file}`);

  const desired = parseChangelog(readFileSync(opts.file, "utf8"));
  if (desired.length === 0) {
    warn(`no versioned entries in ${opts.file}`);
    return result;
  }

  const remote = await cowl.listChangelog(opts.workspace, true);
  const byTitle = new Map<string, RemoteChangelog>();
  for (const e of remote) {
    const key = e.title.toLowerCase();
    if (!byTitle.has(key)) byTitle.set(key, e);
  }

  const claimed = new Set<number>();
  let publishDenied = false;

  const create = async (d: ParsedChangelogEntry): Promise<void> => {
    const base = {
      title: d.version,
      markdown: d.markdown,
      tags: d.tags,
      publishedAt: d.publishedAt,
    };
    try {
      await cowl.createChangelog(opts.workspace, {
        ...base,
        status: publishDenied ? "draft" : "published",
      });
    } catch (err) {
      if (err instanceof CowlAPIError && err.isPermissionDenied("changelog.publish")) {
        publishDenied = true;
        warn("token lacks changelog.publish; creating entries as drafts");
        await cowl.createChangelog(opts.workspace, base);
      } else {
        throw err;
      }
    }
    result.lines.push(`created "${d.version}"`);
    result.created++;
  };

  const update = async (d: ParsedChangelogEntry, r: RemoteChangelog): Promise<void> => {
    const patch: {
      id: number;
      markdown?: string;
      tags?: string[];
      publishedAt?: string;
      status?: string;
    } = { id: r.id };
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
    if (wantPublish) {
      patch.status = "published";
      reasons.push("publish");
    }

    if (reasons.length === 0) {
      result.skipped++;
      return;
    }
    if (opts.dryRun) {
      result.lines.push(`update "${d.version}" (${reasons.join(", ")})`);
      result.updated++;
      return;
    }

    try {
      await cowl.updateChangelog(opts.workspace, patch);
    } catch (err) {
      if (
        err instanceof CowlAPIError &&
        err.isPermissionDenied("changelog.publish") &&
        patch.status
      ) {
        publishDenied = true;
        warn("token lacks changelog.publish; updating without status");
        delete patch.status;
        if (
          patch.markdown !== undefined ||
          patch.tags !== undefined ||
          patch.publishedAt !== undefined
        ) {
          await cowl.updateChangelog(opts.workspace, patch);
        } else {
          result.skipped++;
          return;
        }
      } else {
        throw err;
      }
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
      } else if (opts.dryRun) {
        result.lines.push(`create "${d.version}"`);
        result.created++;
      } else {
        await create(d);
      }
    } catch (err) {
      warn(`entry "${d.version}" failed: ${(err as Error).message}`);
    }
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
        await cowl.deleteChangelog(opts.workspace, e.id);
        result.lines.push(`deleted "${e.title}"`);
        result.deleted++;
      } catch (err) {
        if (err instanceof CowlAPIError && err.isPermissionDenied("changelog.delete")) {
          deleteDenied = true;
          warn("token lacks changelog.delete; skipping prune");
        } else {
          warn(`delete "${e.title}" failed: ${(err as Error).message}`);
        }
      }
    }
  }

  return result;
}
