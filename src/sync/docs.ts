// Syncs a directory of Markdown files into a workspace's articles.
//
// Identity: an explicit front-matter `slug` that already exists remotely, else
// an exact (case-insensitive) title match, else create. Unchanged articles are
// skipped so the platform's revision history and audit trail are not churned.
// Encrypted and OpenAPI-generated pages are never modified. Prune (opt-in)
// deprecates workspace articles absent from the repo (there is no hard delete).
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
  Cowl,
  CreatedArticle,
  PendingReview,
  RemoteArticle,
  RemoteSection,
  UpdateArticleArgs,
} from "../types.js";
import { CowlAPIError, describeError } from "../types.js";
import type { Logger } from "../logger.js";
import { type SurfaceResult, addProposed, emptyResult } from "./plan.js";
import { walkMarkdown } from "../util/walk.js";
import { type DesiredArticle, parseArticle } from "../util/markdown.js";
import { mapLimit } from "../util/concurrency.js";
import { num } from "../util/json.js";

export interface DocsSyncOptions {
  dir: string;
  workspace: string | undefined;
  prune: boolean;
  dryRun: boolean;
  /** Accept a body that the server refuses as a large removal. */
  allowShrink: boolean;
  /** Note for the reviewer on each write that can wait for review. */
  note?: string;
}

const READ_CONCURRENCY = 5;

/** Keep the pending review of a write. A write that the server applied has none. */
function keep(reviews: PendingReview[], review: PendingReview | null): void {
  if (review) reviews.push(review);
}

/** True when `nav` holds a sidebar section key. Unplaced articles have `none` or "". */
function isPlaced(nav: string): boolean {
  return nav !== "" && nav !== "none";
}

/** Section labels match without regard to case or outer spaces, as on the server. */
function labelKey(label: string): string {
  return label.trim().toLowerCase();
}

/**
 * Map each section label to its sidebar key. The section list also holds
 * sections without articles. Servers before the contract have no section list,
 * so the map then comes from the labels of placed articles. An unplaced
 * article keeps the label from its create, but its nav is `none`.
 */
async function sectionKeyMap(
  cowl: Cowl,
  workspace: string | undefined,
  articles: readonly RemoteArticle[],
): Promise<Map<string, string>> {
  let sections: RemoteSection[];
  try {
    sections = await cowl.listSections(workspace);
  } catch (err) {
    if (!(err instanceof CowlAPIError && (err.status === 404 || err.status === 405))) throw err;
    sections = articles
      .filter((a) => isPlaced(a.nav))
      .map((a) => ({ key: a.nav, label: a.section }));
  }
  const keys = new Map<string, string>();
  for (const { key, label } of sections) {
    const k = labelKey(label);
    if (k && key && !keys.has(k)) keys.set(k, key);
  }
  return keys;
}

function isGeneratedPageError(err: unknown): boolean {
  return err instanceof CowlAPIError && err.code === "openapi_generated";
}

/** True for a 402 from a plan check or a 403 from the permission check. */
function isRefusal(err: unknown): err is CowlAPIError {
  return err instanceof CowlAPIError && (err.status === 402 || err.status === 403);
}

/** `"A"`, `"A" and "B"`, or `"A", "B" and "C"`. */
function quotedList(items: readonly string[]): string {
  const quoted = items.map((item) => `"${item}"`);
  const last = quoted.pop() ?? "";
  return quoted.length > 0 ? `${quoted.join(", ")} and ${last}` : last;
}

/**
 * The warning for the sections that the server refused to create. A 402 comes
 * from a plan check, and a 403 from a key without section.create.
 */
function sectionRefusedWarning(err: CowlAPIError, labels: readonly string[]): string {
  const [noun, these] =
    labels.length === 1 ? ["section", "this section"] : ["sections", "these sections"];
  const reason =
    err.status === 402 ? "your plan does not allow section.create" : "the key lacks section.create";
  const remedy =
    err.status === 402
      ? `create the ${noun} in the app or upgrade the plan`
      : `add section.create to the key or create the ${noun} in the app`;
  return (
    `${reason}, so the action cannot create the ${noun} ${quotedList(labels)}. ` +
    `It syncs the articles for ${these} but does not place them there. ` +
    `To place them, ${remedy}. Server error: ${describeError(err)}`
  );
}

/**
 * The warning for the articles that the server refused to move. A 402 refuses
 * a section that is not public, and a 403 comes from a key without article.place.
 */
function placeRefusedWarning(err: CowlAPIError, titles: readonly string[]): string {
  const one = titles.length === 1;
  const articles = `${one ? "the article" : "the articles"} ${quotedList(titles)}`;
  const [target, it, into] = one
    ? ["the article", "it", "its section"]
    : ["the articles", "them", "their sections"];
  const reason =
    err.status === 402
      ? `your plan does not allow article.place for ${articles}, so the action cannot move ${it}`
      : `the key lacks article.place, so the action cannot move ${articles}`;
  const remedy =
    err.status === 402
      ? "upgrade the plan"
      : `add article.place to the key or move ${it} in the app`;
  return (
    `${reason} into ${into}. It syncs the content and keeps the current placement. ` +
    `To move ${target}, ${remedy}. Server error: ${describeError(err)}`
  );
}

function removalText(err: CowlAPIError): string {
  const removed = num(err.details.removed, -1);
  const current = num(err.details.currentLength, -1);
  return removed >= 0 && current > 0
    ? `the new body removes ${removed} of ${current} characters`
    : "the new body removes most of the current text";
}

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
  const fail = (m: string) => {
    result.failed++;
    result.failures.push(m);
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

  const listed = await cowl.listArticles(opts.workspace);
  const sectionKeys = await sectionKeyMap(cowl, opts.workspace, listed);

  // Remote index; encrypted articles are untouchable and excluded entirely.
  const remote = listed.filter((a) => !a.encrypted);
  const bySlug = new Map(remote.map((a) => [a.slug, a]));
  const byTitle = new Map<string, RemoteArticle>();
  for (const a of remote) {
    const key = a.title.toLowerCase();
    if (!byTitle.has(key)) byTitle.set(key, a);
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
    if (!m) {
      creates.push(d);
      continue;
    }
    claimed.add(m.slug);
    if (m.source === "openapi") {
      warn(`skipped OpenAPI-generated page "${m.title}"`);
    } else {
      candidates.push({ d, remote: m });
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

  // Returns false when the key lacks article.publish. A status change that
  // waits for review adds its review to reviews.
  let publishDenied = false;
  const setStatus = async (
    slug: string,
    status: string,
    reviews: PendingReview[],
  ): Promise<boolean> => {
    if (publishDenied) return false;
    try {
      keep(reviews, await cowl.updateArticle(opts.workspace, { slug, status, note: opts.note }));
      return true;
    } catch (err) {
      if (err instanceof CowlAPIError && err.isPermissionDenied("article.publish")) {
        publishDenied = true;
        warn("the key lacks article.publish, so the action does not change article status.");
        return false;
      }
      throw err;
    }
  };

  // Placement is secondary to the content. A 402 or 403 from createSection or
  // from the placement leaves the article where it is. The content still
  // syncs, and the run warns once for each of the two refusals. Other errors
  // fail the article.
  let sectionRefusal: CowlAPIError | undefined;
  const refusedLabels = new Map<string, string>();
  const sectionKeyFor = async (label: string): Promise<string | undefined> => {
    const k = labelKey(label);
    const existing = sectionKeys.get(k);
    if (existing) return existing;
    if (!sectionRefusal) {
      try {
        const key = await cowl.createSection(opts.workspace, label);
        sectionKeys.set(k, key);
        return key;
      } catch (err) {
        if (!isRefusal(err)) throw err;
        sectionRefusal = err;
      }
    }
    if (!refusedLabels.has(k)) refusedLabels.set(k, label.trim());
    return undefined;
  };

  // A 403 means that the key lacks article.place, so the run sends no more
  // placement requests. A 402 refuses only a section that is not public, so
  // the run still tries to move the other articles. Returns true when the
  // article moved. A move that waits for review adds its review to reviews.
  let placeRefusal: CowlAPIError | undefined;
  let placeDenied = false;
  const unmoved: string[] = [];
  const placeInSection = async (
    d: DesiredArticle,
    slug: string,
    reviews: PendingReview[],
  ): Promise<boolean> => {
    if (!placeDenied) {
      const key = await sectionKeyFor(d.section);
      if (!key) return false;
      try {
        const review = await cowl.placeArticle(opts.workspace, slug, key, opts.note);
        keep(reviews, review);
        return review === null;
      } catch (err) {
        if (!isRefusal(err)) throw err;
        if (!placeRefusal) placeRefusal = err;
        if (err.status === 403) placeDenied = true;
      }
    }
    unmoved.push(d.title);
    return false;
  };

  // Servers without section_key decode request bodies strictly and answer 400
  // invalid_body for the unknown field. The server writes nothing then, so the
  // create repeats without the field, and the caller places the article. A 402
  // refuses a section that is not public. The create then also repeats without
  // the field, and the placement reports the refusal.
  let sectionKeyRejected = false;
  const createArticle = async (
    d: DesiredArticle,
    sectionKey: string | undefined,
  ): Promise<CreatedArticle> => {
    const args = { title: d.title, slug: d.slug, section: d.section, markdown: d.markdown };
    if (!sectionKey || sectionKeyRejected) return cowl.createArticle(opts.workspace, args);
    try {
      return await cowl.createArticle(opts.workspace, { ...args, sectionKey });
    } catch (err) {
      if (err instanceof CowlAPIError && err.status === 402) {
        return cowl.createArticle(opts.workspace, args);
      }
      if (!(err instanceof CowlAPIError && err.status === 400 && err.code === "invalid_body")) {
        throw err;
      }
      const created = await cowl.createArticle(opts.workspace, args);
      sectionKeyRejected = true;
      return created;
    }
  };

  // The server refuses a body that removes most of an article (large_removal),
  // which guards against a broken file. The action sends the body again with
  // allow_shrink only when allow-shrink is true. It never sends allow_shrink
  // first, because servers before the contract reject the unknown field.
  const patchArticle = async (
    d: DesiredArticle,
    patch: UpdateArticleArgs,
  ): Promise<PendingReview | null> => {
    try {
      return await cowl.updateArticle(opts.workspace, patch);
    } catch (err) {
      if (!(err instanceof CowlAPIError) || err.code !== "large_removal") throw err;
      if (patch.markdown === undefined) throw err;
      if (!opts.allowShrink) {
        throw new CowlAPIError(
          err.operation,
          `${removalText(err)}. To accept it, set the allow-shrink input to true`,
          err.status,
          err.code,
          err.details,
        );
      }
      warn(`"${d.title}": ${removalText(err)}. The action sends it with allow_shrink.`);
      return cowl.updateArticle(opts.workspace, { ...patch, allowShrink: true });
    }
  };

  // Creates. Placement comes before the status change, because publishing an
  // unplaced article puts it in the first sidebar section. The new article is
  // a draft, so only its publish can wait for review. It then counts as
  // proposed, not as created.
  for (const d of creates) {
    if (opts.dryRun) {
      result.lines.push(`create "${d.title}" in ${d.section} (${d.sourceRel})`);
      result.created++;
      continue;
    }
    try {
      const reviews: PendingReview[] = [];
      const known = sectionKeys.get(labelKey(d.section));
      const created = await createArticle(d, known);
      const placed =
        (known !== undefined && created.nav === known) ||
        (await placeInSection(d, created.slug, reviews));
      if (d.status && d.status !== "DRAFT") await setStatus(created.slug, d.status, reviews);
      const line = placed ? `created "${d.title}" in ${d.section}` : `created "${d.title}"`;
      if (reviews.length > 0) {
        result.lines.push(`${line} as a draft`);
        addProposed(result, `"${d.title}"`, reviews);
      } else {
        result.lines.push(line);
        result.created++;
      }
    } catch (err) {
      fail(`create "${d.title}" failed: ${describeError(err)}`);
    }
  }

  // Updates / skips.
  for (let i = 0; i < candidates.length; i++) {
    const { d, remote: r } = candidates[i];
    const body = bodies[i];
    const patch: UpdateArticleArgs = { slug: r.slug, note: opts.note };
    const reasons: string[] = [];
    if (body === null || body.trim() !== d.markdown.trim()) {
      patch.markdown = d.markdown;
      reasons.push("body");
    }
    if (d.title !== r.title) {
      patch.title = d.title;
      reasons.push("title");
    }
    const sectionChanged = labelKey(d.section) !== labelKey(r.section);
    if (sectionChanged) reasons.push("section");
    // An earlier run can create an article and then fail to place it. The
    // article keeps its section label, so only its nav shows the gap.
    const needsPlacement = sectionChanged || !isPlaced(r.nav);
    const statusChanged = !!d.status && d.status !== r.status;

    if (reasons.length === 0 && !needsPlacement && !statusChanged) {
      result.skipped++;
      continue;
    }

    if (opts.dryRun) {
      const all = [
        ...reasons,
        ...(needsPlacement && !sectionChanged ? ["placement"] : []),
        ...(statusChanged ? ["status"] : []),
      ];
      result.lines.push(`update "${d.title}" (${all.join(", ")})`);
      result.updated++;
      continue;
    }

    try {
      const reviews: PendingReview[] = [];
      const edited = patch.markdown !== undefined || patch.title !== undefined;
      if (edited) {
        if (d.version) patch.version = d.version;
        keep(reviews, await patchArticle(d, patch));
      }
      // The label changes only after the move. An article that cannot move,
      // or whose move waits for review, keeps its label, so a later run still
      // sees the move and places it.
      const moved = needsPlacement && (await placeInSection(d, r.slug, reviews));
      if (moved && sectionChanged) {
        keep(
          reviews,
          await cowl.updateArticle(opts.workspace, {
            slug: r.slug,
            section: d.section,
            note: opts.note,
          }),
        );
      }
      if (statusChanged && d.status) await setStatus(r.slug, d.status, reviews);
      if (reviews.length > 0) {
        addProposed(result, `"${d.title}"`, reviews);
      } else if (edited || moved || statusChanged) {
        result.lines.push(`updated "${d.title}"`);
        result.updated++;
      } else {
        result.skipped++;
      }
    } catch (err) {
      if (isGeneratedPageError(err)) {
        warn(`skipped OpenAPI-generated page "${r.title}"`);
      } else {
        fail(`update "${d.title}" failed: ${describeError(err)}`);
      }
    }
  }

  if (sectionRefusal) warn(sectionRefusedWarning(sectionRefusal, [...refusedLabels.values()]));
  if (placeRefusal) warn(placeRefusedWarning(placeRefusal, unmoved));

  // Prune: deprecate remote articles not represented in the repo. Generated
  // OpenAPI pages belong to the OpenAPI sync.
  const orphans = remote.filter(
    (a) => !claimed.has(a.slug) && a.status !== "DEPRECATED" && a.source !== "openapi",
  );
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
      try {
        const reviews: PendingReview[] = [];
        if (!(await setStatus(a.slug, "DEPRECATED", reviews))) continue;
        if (reviews.length > 0) {
          addProposed(result, `"${a.title}"`, reviews);
        } else {
          result.lines.push(`deprecated "${a.title}"`);
          result.deleted++;
        }
      } catch (err) {
        if (isGeneratedPageError(err)) {
          warn(`skipped OpenAPI-generated page "${a.title}" during prune`);
        } else {
          fail(`deprecate "${a.title}" failed: ${describeError(err)}`);
        }
      }
    }
  }

  return result;
}

/** Resolve a config-relative docs dir against the workspace root. */
export function docsDir(root: string, dir: string): string {
  return join(root, dir);
}
