// Syncs a directory of Markdown files into a workspace's articles.
//
// Identity: an explicit front-matter `slug` that already exists remotely, else
// an exact (case-insensitive) title match, else create. Unchanged articles are
// skipped so the platform's revision history and audit trail are not churned.
// Encrypted and OpenAPI-generated pages are never modified. Prune (opt-in)
// deprecates workspace articles absent from the repo (there is no hard delete).
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Cowl, RemoteArticle } from "../types.js";
import { CowlAPIError } from "../types.js";
import type { Logger } from "../logger.js";
import { type SurfaceResult, emptyResult } from "./plan.js";
import { walkMarkdown } from "../util/walk.js";
import { type DesiredArticle, parseArticle } from "../util/markdown.js";
import { mapLimit } from "../util/concurrency.js";

export interface DocsSyncOptions {
  dir: string;
  workspace: string | undefined;
  prune: boolean;
  dryRun: boolean;
}

const READ_CONCURRENCY = 5;

export async function syncDocs(
  cowl: Cowl,
  logger: Logger,
  opts: DocsSyncOptions,
): Promise<SurfaceResult> {
  const result = emptyResult("docs");
  const warn = (m: string) => {
    result.warnings.push(m);
    logger.warning(`docs: ${m}`);
  };

  if (!existsSync(opts.dir) || !statSync(opts.dir).isDirectory()) {
    throw new Error(`docs.dir not found: ${opts.dir}`);
  }

  const desired = walkMarkdown(opts.dir).map((f) => parseArticle(f, readFileSync(f.path, "utf8")));
  if (desired.length === 0) {
    warn(`no Markdown files under ${opts.dir}`);
    return result;
  }

  const seenTitles = new Map<string, string>();
  for (const d of desired) {
    const key = d.title.toLowerCase();
    if (seenTitles.has(key)) {
      warn(`duplicate title "${d.title}" (${d.sourceRel} and ${seenTitles.get(key)})`);
    } else {
      seenTitles.set(key, d.sourceRel);
    }
  }

  // Remote index; encrypted articles are untouchable and excluded entirely.
  const remote = (await cowl.listArticles(opts.workspace)).filter((a) => !a.encrypted);
  const bySlug = new Map(remote.map((a) => [a.slug, a]));
  const byTitle = new Map<string, RemoteArticle>();
  for (const a of remote) {
    const key = a.title.toLowerCase();
    if (!byTitle.has(key)) byTitle.set(key, a);
  }
  // Reuse nav-group keys discovered from placed articles; label -> nav key.
  const sectionKeys = new Map<string, string>();
  for (const a of remote) {
    if (a.section && a.nav) sectionKeys.set(a.section.toLowerCase(), a.nav);
  }

  const claimed = new Set<string>();
  const matchOf = (d: DesiredArticle): RemoteArticle | undefined => {
    if (d.slug && bySlug.has(d.slug)) return bySlug.get(d.slug);
    return byTitle.get(d.title.toLowerCase());
  };

  // Split into creates and update-candidates; claim matched slugs for prune.
  const creates: DesiredArticle[] = [];
  const candidates: { d: DesiredArticle; remote: RemoteArticle }[] = [];
  for (const d of desired) {
    const m = matchOf(d);
    if (m) {
      claimed.add(m.slug);
      candidates.push({ d, remote: m });
    } else {
      creates.push(d);
    }
  }

  // Fetch current bodies concurrently to decide skip vs update.
  const bodies = await mapLimit(candidates, READ_CONCURRENCY, async (c) => {
    try {
      return await cowl.getArticleMarkdown(opts.workspace, c.remote.slug);
    } catch {
      return null; // treat as changed if unreadable
    }
  });

  let publishDenied = false;
  const setStatus = async (slug: string, status: string): Promise<boolean> => {
    if (publishDenied) return false;
    try {
      await cowl.updateArticle(opts.workspace, { slug, status });
      return true;
    } catch (err) {
      if (err instanceof CowlAPIError && err.isPermissionDenied("article.publish")) {
        publishDenied = true;
        warn("token lacks article.publish; leaving status unchanged");
        return false;
      }
      throw err;
    }
  };

  const ensureSectionKey = async (label: string): Promise<string> => {
    const existing = sectionKeys.get(label.toLowerCase());
    if (existing) return existing;
    const key = await cowl.createSection(opts.workspace, label);
    sectionKeys.set(label.toLowerCase(), key);
    return key;
  };

  // Creates.
  for (const d of creates) {
    if (opts.dryRun) {
      result.lines.push(`create "${d.title}" in ${d.section} (${d.sourceRel})`);
      result.created++;
      continue;
    }
    try {
      const slug = await cowl.createArticle(opts.workspace, {
        title: d.title,
        slug: d.slug,
        section: d.section,
        markdown: d.markdown,
      });
      const key = await ensureSectionKey(d.section);
      await cowl.placeArticle(opts.workspace, slug, key);
      if (d.status && d.status !== "DRAFT") await setStatus(slug, d.status);
      result.lines.push(`created "${d.title}" in ${d.section}`);
      result.created++;
    } catch (err) {
      warn(`create "${d.title}" failed: ${(err as Error).message}`);
    }
  }

  // Updates / skips.
  for (let i = 0; i < candidates.length; i++) {
    const { d, remote: r } = candidates[i];
    const body = bodies[i];
    const patch: { slug: string; title?: string; section?: string; markdown?: string } = {
      slug: r.slug,
    };
    const reasons: string[] = [];
    if (body === null || body.trim() !== d.markdown.trim()) {
      patch.markdown = d.markdown;
      reasons.push("body");
    }
    if (d.title !== r.title) {
      patch.title = d.title;
      reasons.push("title");
    }
    const sectionChanged = d.section.toLowerCase() !== r.section.toLowerCase();
    if (sectionChanged) {
      patch.section = d.section;
      reasons.push("section");
    }
    const statusChanged = !!d.status && d.status !== r.status;

    if (reasons.length === 0 && !statusChanged) {
      result.skipped++;
      continue;
    }

    if (opts.dryRun) {
      const all = [...reasons, ...(statusChanged ? ["status"] : [])];
      result.lines.push(`update "${d.title}" (${all.join(", ")})`);
      result.updated++;
      continue;
    }

    try {
      if (reasons.length > 0) {
        if (d.version) (patch as { version?: string }).version = d.version;
        await cowl.updateArticle(opts.workspace, patch);
        if (sectionChanged) {
          const key = await ensureSectionKey(d.section);
          await cowl.placeArticle(opts.workspace, r.slug, key);
        }
      }
      if (statusChanged && d.status) await setStatus(r.slug, d.status);
      result.lines.push(`updated "${d.title}"`);
      result.updated++;
    } catch (err) {
      if (err instanceof CowlAPIError && /openapi/i.test(err.message)) {
        warn(`skipped OpenAPI-generated page "${r.title}"`);
      } else {
        warn(`update "${d.title}" failed: ${(err as Error).message}`);
      }
    }
  }

  // Prune: deprecate remote articles not represented in the repo.
  const orphans = remote.filter((a) => !claimed.has(a.slug) && a.status !== "DEPRECATED");
  if (orphans.length > 0 && !opts.prune) {
    logger.info(`docs: ${orphans.length} article(s) not in repo (enable prune to deprecate)`);
  }
  if (opts.prune) {
    for (const a of orphans) {
      if (opts.dryRun) {
        result.lines.push(`deprecate "${a.title}"`);
        result.deleted++;
        continue;
      }
      if (publishDenied) break;
      const ok = await setStatus(a.slug, "DEPRECATED").catch((err) => {
        if (err instanceof CowlAPIError && /openapi/i.test(err.message)) {
          warn(`skipped OpenAPI-generated page "${a.title}" during prune`);
          return false;
        }
        throw err;
      });
      if (ok) {
        result.lines.push(`deprecated "${a.title}"`);
        result.deleted++;
      }
    }
  }

  return result;
}

/** Resolve a config-relative docs dir against the workspace root. */
export function docsDir(root: string, dir: string): string {
  return join(root, dir);
}
