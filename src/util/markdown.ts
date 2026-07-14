// Parses a Markdown file into a desired article: front-matter + derived title,
// section, and body.
import matter from "gray-matter";
import { basename, dirname } from "node:path";
import type { MarkdownFile } from "./walk.js";

/** Valid article statuses accepted by ContextOwl (uppercase on the wire). */
export const ARTICLE_STATUSES = ["DRAFT", "IN REVIEW", "BETA", "STABLE", "DEPRECATED"] as const;
export type ArticleStatus = (typeof ARTICLE_STATUSES)[number];

export interface DesiredArticle {
  /** Explicit slug from front-matter, if any (create derives its own slug). */
  slug?: string;
  title: string;
  section: string;
  status?: ArticleStatus;
  version?: string;
  markdown: string;
  /** Source path relative to the docs dir, for logging. */
  sourceRel: string;
}

const DEFAULT_SECTION = "Guides";

function firstHeading(body: string): string | undefined {
  const m = body.match(/^#\s+(.+?)\s*$/m);
  return m ? m[1].trim() : undefined;
}

/** Turn "getting-started_v2.md" into "Getting Started V2". */
export function titleFromFilename(file: string): string {
  return basename(file)
    .replace(/\.mdx?$/i, "")
    .replace(/[-_]+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Section label from the immediate parent directory, or the default. */
function sectionFromDir(rel: string): string {
  const dir = dirname(rel);
  if (dir === "." || dir === "") return DEFAULT_SECTION;
  const leaf = dir.split("/").pop() as string;
  return leaf.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function normalizeStatus(value: unknown, sourceRel: string): ArticleStatus | undefined {
  if (value === undefined || value === null) return undefined;
  const s = String(value).toUpperCase().trim();
  if (!(ARTICLE_STATUSES as readonly string[]).includes(s)) {
    throw new Error(
      `${sourceRel}: invalid status "${value}". Use one of: ${ARTICLE_STATUSES.join(", ")}.`,
    );
  }
  return s as ArticleStatus;
}

/** Parse one Markdown file into a DesiredArticle. */
export function parseArticle(file: MarkdownFile, raw: string): DesiredArticle {
  const { data, content } = matter(raw);
  const body = content.trim();
  const title =
    (typeof data.title === "string" && data.title.trim()) ||
    firstHeading(body) ||
    titleFromFilename(file.rel);
  const section =
    (typeof data.section === "string" && data.section.trim()) || sectionFromDir(file.rel);
  const slug = typeof data.slug === "string" && data.slug.trim() ? data.slug.trim() : undefined;
  const version =
    typeof data.version === "string" && data.version.trim() ? data.version.trim() : undefined;
  return {
    slug,
    title,
    section,
    status: normalizeStatus(data.status, file.rel),
    version,
    markdown: body,
    sourceRel: file.rel,
  };
}
