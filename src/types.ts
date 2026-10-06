// Shared domain types and the Cowl gateway interface. The gateway keeps sync
// logic testable: production uses the REST API and tests inject an in-memory fake.

/** Article row as returned by the REST API. */
export interface RemoteArticle {
  slug: string;
  title: string;
  section: string;
  /** Sidebar section key. `none` or an empty string means the article is not placed. */
  nav: string;
  status: string;
  encrypted: boolean;
  /** `openapi` for generated API reference pages. Empty for other pages and on older servers. */
  source: string;
}

/** Sidebar section as returned by the REST API. */
export interface RemoteSection {
  key: string;
  label: string;
}

/** Changelog entry as returned by the REST API. */
export interface RemoteChangelog {
  id: number;
  title: string;
  markdown: string;
  tags: string[];
  status: string;
  publishedAt: string | null;
}

/** Page counts returned by an OpenAPI attach/sync. */
export interface OpenapiStats {
  created: number;
  updated: number;
  deleted: number;
}

export interface OpenapiAttachResult {
  /** Page counts, or null when the server does not report them. */
  stats: OpenapiStats | null;
  /** True when the spec equals the stored spec and the server kept the pages. */
  unchanged: boolean;
}

export interface CreateArticleArgs {
  title: string;
  slug?: string;
  section?: string;
  /** Key of an existing sidebar section that the new article goes into. */
  sectionKey?: string;
  markdown: string;
}

export interface CreatedArticle {
  slug: string;
  /** Sidebar section key after the create. Empty when the server does not report it. */
  nav: string;
}

export interface UpdateArticleArgs {
  slug: string;
  title?: string;
  section?: string;
  markdown?: string;
  status?: string;
  version?: string;
  /** Accept a body that removes most of the current text. */
  allowShrink?: boolean;
}

/** One page request for the changelog list. */
export interface ChangelogListQuery {
  drafts: boolean;
  limit?: number;
  offset?: number;
}

export interface CreateChangelogArgs {
  title: string;
  markdown: string;
  tags?: string[];
  status?: string;
  publishedAt?: string;
}

export interface UpdateChangelogArgs {
  id: number;
  title?: string;
  markdown?: string;
  tags?: string[];
  status?: string;
  publishedAt?: string;
}

/**
 * Typed wrapper over the ContextOwl REST operations the action uses. Every
 * method targets a single workspace; pass `undefined` for a workspace-bound key.
 */
export interface Cowl {
  listArticles(workspace: string | undefined): Promise<RemoteArticle[]>;
  /** List the sidebar sections in sidebar order. Servers before the contract answer 404. */
  listSections(workspace: string | undefined): Promise<RemoteSection[]>;
  getArticleMarkdown(workspace: string | undefined, slug: string): Promise<string>;
  createArticle(workspace: string | undefined, args: CreateArticleArgs): Promise<CreatedArticle>;
  updateArticle(workspace: string | undefined, args: UpdateArticleArgs): Promise<void>;
  createSection(workspace: string | undefined, label: string): Promise<string>;
  placeArticle(workspace: string | undefined, slug: string, sectionKey: string): Promise<void>;
  /** List one page of changelog entries. */
  listChangelog(
    workspace: string | undefined,
    query: ChangelogListQuery,
  ): Promise<RemoteChangelog[]>;
  createChangelog(workspace: string | undefined, args: CreateChangelogArgs): Promise<number>;
  updateChangelog(workspace: string | undefined, args: UpdateChangelogArgs): Promise<void>;
  deleteChangelog(workspace: string | undefined, id: number): Promise<void>;
  attachOpenapi(workspace: string | undefined, spec: string): Promise<OpenapiAttachResult>;
}

/** Error raised when a REST operation returns an error response. */
export class CowlAPIError extends Error {
  constructor(
    public operation: string,
    message: string,
    public status?: number,
    public code?: string,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CowlAPIError";
  }

  /**
   * True when the server answered HTTP 403. With `permission`, the error must
   * also name it. Newer servers name it in `details.permission`. Older servers
   * name it only in the message, and only for some checks.
   */
  isPermissionDenied(permission?: string): boolean {
    if (this.status !== 403) return false;
    if (!permission) return true;
    const named = this.details.permission;
    return typeof named === "string" ? named === permission : this.message.includes(permission);
  }
}

/** One line for a log or summary: the HTTP status and error code come first when known. */
export function describeError(err: unknown): string {
  if (err instanceof CowlAPIError && err.status) {
    return `${err.status}${err.code ? ` ${err.code}` : ""}: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}
