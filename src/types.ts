// Shared domain types and the Cowl gateway interface.
//
// The gateway is the seam that keeps sync logic testable: the real
// implementation (src/mcp/client.ts) talks to the ContextOwl MCP endpoint,
// while tests inject an in-memory fake. Sync modules depend only on this
// interface, never on the MCP SDK directly.

/** Article row as returned by the `list_articles` MCP tool. */
export interface RemoteArticle {
  slug: string;
  title: string;
  section: string;
  nav: string;
  status: string;
  encrypted: boolean;
}

/** Changelog entry as returned by `list_changelog` / `create_changelog`. */
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

export interface CreateArticleArgs {
  title: string;
  section?: string;
  markdown: string;
}

export interface UpdateArticleArgs {
  slug: string;
  title?: string;
  section?: string;
  markdown?: string;
  status?: string;
  version?: string;
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
 * Typed wrapper over the ContextOwl MCP tools the action uses. Every method
 * targets a single workspace; pass `undefined` to let a workspace-bound token
 * resolve its own workspace server-side.
 */
export interface Cowl {
  listArticles(workspace: string | undefined): Promise<RemoteArticle[]>;
  getArticleMarkdown(workspace: string | undefined, slug: string): Promise<string>;
  createArticle(workspace: string | undefined, args: CreateArticleArgs): Promise<string>;
  updateArticle(workspace: string | undefined, args: UpdateArticleArgs): Promise<void>;
  createSection(workspace: string | undefined, label: string): Promise<string>;
  placeArticle(workspace: string | undefined, slug: string, sectionKey: string): Promise<void>;
  listChangelog(workspace: string | undefined, drafts: boolean): Promise<RemoteChangelog[]>;
  createChangelog(workspace: string | undefined, args: CreateChangelogArgs): Promise<number>;
  updateChangelog(workspace: string | undefined, args: UpdateChangelogArgs): Promise<void>;
  deleteChangelog(workspace: string | undefined, id: number): Promise<void>;
  attachOpenapi(workspace: string | undefined, spec: string): Promise<OpenapiStats | null>;
}

/** Error raised when an MCP tool returns an error result. */
export class CowlToolError extends Error {
  constructor(
    public tool: string,
    message: string,
  ) {
    super(message);
    this.name = "CowlToolError";
  }

  /** True when the failure is a permission denial for `capability`. */
  isPermissionDenied(capability?: string): boolean {
    if (!/permission denied/i.test(this.message)) return false;
    return capability ? this.message.includes(capability) : true;
  }
}
