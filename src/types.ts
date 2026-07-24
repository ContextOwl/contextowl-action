// Shared domain types and the Cowl gateway interface. The gateway keeps sync
// logic testable: production uses the REST API and tests inject an in-memory fake.

/** Article row as returned by the REST API. */
export interface RemoteArticle {
  slug: string;
  title: string;
  section: string;
  nav: string;
  status: string;
  encrypted: boolean;
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
 * Typed wrapper over the ContextOwl REST operations the action uses. Every
 * method targets a single workspace; pass `undefined` for a workspace-bound key.
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

/** Error raised when a REST operation returns an error response. */
export class CowlAPIError extends Error {
  constructor(
    public operation: string,
    message: string,
    public status?: number,
    public code?: string,
  ) {
    super(message);
    this.name = "CowlAPIError";
  }

  /** True when the failure is a permission denial for `capability`. */
  isPermissionDenied(capability?: string): boolean {
    if (this.status !== 403 || this.code !== "permission_denied") return false;
    return capability ? this.message.includes(capability) : true;
  }
}
