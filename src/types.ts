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
  /** The proposal that holds the spec when it waits for review, else null. */
  review: PendingReview | null;
}

/**
 * A change that waits for an editor. When the organization reviews agent
 * changes and the key is not a publishing key, the server answers 202 to a
 * write that changes live content and keeps the change in a proposal. Older
 * servers never answer 202, so every field is optional on the wire.
 */
export interface PendingReview {
  /** Proposal id, or 0 when the server does not send it. */
  id: number;
  /** What the proposal changes, such as article, placement, changelog or openapi. */
  objectType: string;
  /** One line that says what the proposal changes. */
  summary: string;
  /** created, updated, unchanged or rebased. */
  outcome: string;
  /** The page in Admin > Proposals where an editor reviews the proposal. */
  reviewUrl: string;
}

/** The fields of GET /api/v1/me that the action reads. */
export interface KeyIdentity {
  /**
   * How the changes of the key to live content apply: none, review or
   * direct. Empty on servers without the review of agent changes.
   */
  writes: string;
  /** The permissions that the key can use. Empty on servers without the list. */
  permissions: string[];
}

/** One row of the proposal list. */
export interface RemoteProposal {
  id: number;
  /** article, placement, changelog, openapi, landing or workspace. */
  objectType: string;
  status: string;
  /**
   * The object that a proposal of a write under review changes, such as
   * article:42, changelog:7 or changelog-new:<hash>. Empty for a proposal
   * that a propose call filed.
   */
  target: string;
  /** The slug of the article, for an article or a placement proposal. */
  slug: string;
  /** The article title, or the title of the changelog entry. */
  title: string;
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
  /** Note for the reviewer when the change waits for review. */
  note?: string;
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
  /** Note for the reviewer when the entry waits for review. */
  note?: string;
}

export interface UpdateChangelogArgs {
  id: number;
  title?: string;
  markdown?: string;
  tags?: string[];
  status?: string;
  publishedAt?: string;
  /** Note for the reviewer when the change waits for review. */
  note?: string;
}

/**
 * Typed wrapper over the ContextOwl REST operations the action uses. Every
 * method targets a single workspace; pass `undefined` for a workspace-bound key.
 *
 * A write that can wait for review returns its pending review when the server
 * answers 202, and null when the server applied the write. Its optional note
 * goes to the reviewer. Servers without the review reject a note in a request
 * body, so send it only when `identity` returns `writes`.
 */
export interface Cowl {
  /** Describe the key with GET /api/v1/me. Servers before the contract answer 404. */
  identity(): Promise<KeyIdentity>;
  /**
   * List the pending proposals of the key owner in the workspace. The list
   * holds the rows of every key of the owner, not only of this key.
   */
  listProposals(workspace: string | undefined): Promise<RemoteProposal[]>;
  listArticles(workspace: string | undefined): Promise<RemoteArticle[]>;
  /** List the sidebar sections in sidebar order. Servers before the contract answer 404. */
  listSections(workspace: string | undefined): Promise<RemoteSection[]>;
  getArticleMarkdown(workspace: string | undefined, slug: string): Promise<string>;
  createArticle(workspace: string | undefined, args: CreateArticleArgs): Promise<CreatedArticle>;
  updateArticle(
    workspace: string | undefined,
    args: UpdateArticleArgs,
  ): Promise<PendingReview | null>;
  createSection(workspace: string | undefined, label: string): Promise<string>;
  placeArticle(
    workspace: string | undefined,
    slug: string,
    sectionKey: string,
    note?: string,
  ): Promise<PendingReview | null>;
  /** List one page of changelog entries. */
  listChangelog(
    workspace: string | undefined,
    query: ChangelogListQuery,
  ): Promise<RemoteChangelog[]>;
  createChangelog(
    workspace: string | undefined,
    args: CreateChangelogArgs,
  ): Promise<PendingReview | null>;
  updateChangelog(
    workspace: string | undefined,
    args: UpdateChangelogArgs,
  ): Promise<PendingReview | null>;
  deleteChangelog(
    workspace: string | undefined,
    id: number,
    note?: string,
  ): Promise<PendingReview | null>;
  attachOpenapi(
    workspace: string | undefined,
    spec: string,
    note?: string,
  ): Promise<OpenapiAttachResult>;
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
