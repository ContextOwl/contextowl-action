// In-memory Cowl gateway for tests. By default it follows the REST contract:
// canonical changelog tags with their aliases, limit and offset paging, and the
// real 402 and 403 error bodies, built by the same parser the REST client uses.
// `legacy: true` simulates a server from before the contract. `writes` turns
// on the review of agent changes. Under review, the fake keeps one working
// copy of the key for each target, as the server does: a write applies to
// the pending proposal of the key, a working copy that equals the live object
// withdraws the proposal, and the large removal check reads the working copy.
import { errorFromResponse } from "../src/api/client.js";
import { type ReviewState, pendingProposals } from "../src/sync/review.js";
import type {
  ChangelogListQuery,
  Cowl,
  CowlAPIError,
  CreateArticleArgs,
  CreateChangelogArgs,
  CreatedArticle,
  KeyIdentity,
  OpenapiAttachResult,
  OpenapiStats,
  PendingReview,
  RemoteArticle,
  RemoteChangelog,
  RemoteProposal,
  RemoteSection,
  UpdateArticleArgs,
  UpdateChangelogArgs,
} from "../src/types.js";

interface StoredArticle extends RemoteArticle {
  markdown: string;
}

/** The fields of an article that a proposal can change, in the order of the server. */
const ARTICLE_FIELDS = ["title", "section", "markdown", "status"] as const;
type ArticleState = Pick<StoredArticle, (typeof ARTICLE_FIELDS)[number]>;

/** The fields of a changelog entry that a proposal can change, in the order of the server. */
const ENTRY_FIELDS = ["title", "markdown", "tags", "status", "publishedAt"] as const;
type EntryState = Pick<RemoteChangelog, (typeof ENTRY_FIELDS)[number]>;

/** The large removal rule of the server: more than 2,000 characters and more than half. */
const LARGE_REMOVAL_CHARS = 2000;

/** The length of a text in Unicode code points, as the server counts it. */
function codePoints(text: string): number {
  return [...text].length;
}

function articleState(a: StoredArticle): ArticleState {
  return { title: a.title, section: a.section, markdown: a.markdown, status: a.status };
}

function entryState(e: RemoteChangelog): EntryState {
  return {
    title: e.title,
    markdown: e.markdown,
    tags: [...e.tags],
    status: e.status,
    publishedAt: e.publishedAt,
  };
}

function sameInstant(a: string | null, b: string | null): boolean {
  if (!a || !b) return a === b;
  return Date.parse(a) === Date.parse(b);
}

/** The fields of an entry that differ from the live entry. Tags compare in order. */
function entryChanges(working: EntryState, live: EntryState): string[] {
  return ENTRY_FIELDS.filter((field) => {
    if (field === "tags") return working.tags.join("\n") !== live.tags.join("\n");
    if (field === "publishedAt") return !sameInstant(working.publishedAt, live.publishedAt);
    return working[field] !== live[field];
  });
}

export const CANONICAL_TAGS = ["new", "improved", "fixed", "deprecated", "security"];

const TAG_ALIASES = new Map<string, string>([
  ["added", "new"],
  ["feature", "new"],
  ["features", "new"],
  ["changed", "improved"],
  ["improvement", "improved"],
  ["improvements", "improved"],
  ["fix", "fixed"],
  ["fixes", "fixed"],
  ["bugfix", "fixed"],
  ["removed", "deprecated"],
  ["deprecation", "deprecated"],
]);

const PUBLISHED_STATUSES = new Set(["BETA", "STABLE", "DEPRECATED"]);

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function unplaced(nav: string): boolean {
  return nav === "" || nav === "none";
}

function live(e: RemoteChangelog): boolean {
  return e.status === "published" && (!e.publishedAt || Date.parse(e.publishedAt) <= Date.now());
}

/** True when readers see the article, as on the server. */
function liveArticle(a: RemoteArticle): boolean {
  return PUBLISHED_STATUSES.has(a.status);
}

/** The base of the review links of the fake. */
export const REVIEW_URL = "https://contextowl.test/admin/proposals?ws=docs&id=";

/** A pending proposal: the working copy of the key for one target. */
export interface FakeProposal {
  id: number;
  objectType: string;
  /** article:<slug>, placement:<slug>, changelog:<id>, changelog-new:<title> or openapi. */
  target: string;
  slug: string;
  title: string;
  summary: string;
  /** The fields that the working copy changes, with their values. */
  change: Record<string, unknown>;
  /** The live object when the key filed the proposal. A different live object rebases it. */
  base: string;
}

function changelogOrder(a: RemoteChangelog, b: RemoteChangelog): number {
  const drafts = Number(b.status === "draft") - Number(a.status === "draft");
  if (drafts !== 0) return drafts;
  return (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "") || b.id - a.id;
}

/** The error the REST client raises for a response with this status and error object. */
export function apiError(
  operation: string,
  status: number,
  error: Record<string, unknown>,
): CowlAPIError {
  return errorFromResponse(operation, status, JSON.stringify({ error: { ...error, status } }));
}

/** 403 from the contract: the message and `details.permission` name the permission. */
export function permissionDenied(operation: string, permission: string): CowlAPIError {
  return apiError(operation, 403, {
    code: "permission_denied",
    message: `this key lacks the ${permission} permission`,
    details: { permission },
  });
}

/** 403 from the operation gate of servers before the contract. It names no permission. */
export function legacyPermissionDenied(operation: string): CowlAPIError {
  return apiError(operation, 403, {
    code: "permission_denied",
    message: "this key lacks the required permission",
  });
}

/**
 * 402 from the plan gate of the contract: the message and `details.permission`
 * name the permission. `details.feature` is mcp_extended, the plan feature of
 * the workspace.* permissions.
 */
export function upgradeRequired(operation: string, permission: string): CowlAPIError {
  return apiError(operation, 402, {
    code: "upgrade_required",
    message: `${permission} needs a paid plan or an active trial`,
    details: { feature: "mcp_extended", permission },
  });
}

/** 402 from the plan gate of servers before the contract. It names no permission. */
export function legacyUpgradeRequired(operation: string): CowlAPIError {
  return apiError(operation, 402, {
    code: "upgrade_required",
    message: "your plan does not include this endpoint",
  });
}

export interface FakePerms {
  articlePublish: boolean;
  articlePlace: boolean;
  sectionCreate: boolean;
  changelogUpdate: boolean;
  changelogPublish: boolean;
  changelogDelete: boolean;
  openapiAttach: boolean;
}

export class FakeCowl implements Cowl {
  readonly legacy: boolean;
  articles = new Map<string, StoredArticle>();
  sections = new Map<string, string>(); // key -> label
  changelog: RemoteChangelog[] = [];
  private nextId = 1;
  openapiSpec: string | null = null;
  openapiStats: OpenapiStats = { created: 0, updated: 0, deleted: 0 };
  /**
   * False makes a legacy server refuse the OpenAPI attach with 402. The plan
   * gate of the contract does not cover openapi.attach.
   */
  planIncludesOpenapi = true;
  /** Return the first page for every offset, like a server that ignores offset. */
  ignoreOffset = false;
  /**
   * The writes field of GET /api/v1/me on a server with the review of agent
   * changes. review files a write that changes live content as a proposal
   * and answers it like a 202. direct applies it. Undefined is a server
   * without the review: GET /api/v1/me has no writes, and a note in a request
   * body answers 400 invalid_body.
   */
  writes?: "review" | "direct";
  /** Pending proposals of the key by target. A repeated write of the key updates its proposal. */
  proposals = new Map<string, FakeProposal>();
  /** Proposals that a write of the key withdrew, in order. */
  withdrawn: FakeProposal[] = [];
  /**
   * Pending proposals of other keys of the same owner. The proposal list
   * holds them, but a write of this key never changes them.
   */
  otherKeyProposals: FakeProposal[] = [];
  private nextProposalId = 1;
  perms: FakePerms = {
    articlePublish: true,
    articlePlace: true,
    sectionCreate: true,
    changelogUpdate: true,
    changelogPublish: true,
    changelogDelete: true,
    openapiAttach: true,
  };

  /** Write calls in order, one short line each. */
  log: string[] = [];
  createArticleCalls: CreateArticleArgs[] = [];
  updateArticleCalls: UpdateArticleArgs[] = [];
  createSectionCalls: string[] = [];
  changelogListCalls: ChangelogListQuery[] = [];
  /** Tags exactly as the action sent them, one array per create or update. */
  sentTags: string[][] = [];
  /** The note of each write that can wait for review, in order. */
  notes: (string | undefined)[] = [];
  listProposalsCalls = 0;
  private injected = new Map<keyof Cowl, CowlAPIError[]>();

  constructor(options: { legacy?: boolean } = {}) {
    this.legacy = options.legacy ?? false;
  }

  /** Make the next call of `operation` throw `err`. */
  failNext(operation: keyof Cowl, err: CowlAPIError): void {
    const queue = this.injected.get(operation) ?? [];
    queue.push(err);
    this.injected.set(operation, queue);
  }

  private enter(operation: keyof Cowl, entry?: string): void {
    if (entry) this.log.push(entry);
    const err = this.injected.get(operation)?.shift();
    if (err) throw err;
  }

  private denied(operation: string, permission: string, legacyMessage?: string): CowlAPIError {
    if (!this.legacy) return permissionDenied(operation, permission);
    if (!legacyMessage) return legacyPermissionDenied(operation);
    return apiError(operation, 403, { code: "permission_denied", message: legacyMessage });
  }

  private normalizeTags(operation: string, tags: string[]): string[] {
    const out: string[] = [];
    for (const raw of tags) {
      const t = raw.trim().toLowerCase();
      if (!t) continue;
      const tag = CANONICAL_TAGS.includes(t) ? t : this.legacy ? undefined : TAG_ALIASES.get(t);
      if (!tag) {
        throw apiError(
          operation,
          400,
          this.legacy
            ? { code: "invalid_request", message: `unknown changelog tag: ${t}` }
            : {
                code: "invalid_request",
                message: `unknown changelog tag "${t}". Use ${CANONICAL_TAGS.join(", ")}. Aliases: ${[...TAG_ALIASES.keys()].join(", ")}.`,
                details: { field: "tags", allowed: CANONICAL_TAGS },
              },
        );
      }
      if (!out.includes(tag)) out.push(tag);
    }
    return out;
  }

  /**
   * Record the note of a write. A server without the review decodes request
   * bodies strictly, so a note in a body answers 400 and writes nothing. It
   * ignores an unknown query parameter.
   */
  private takeNote(operation: string, note: string | undefined, inBody = true): void {
    this.notes.push(note);
    if (note !== undefined && inBody && this.writes === undefined) {
      throw apiError(operation, 400, {
        code: "invalid_body",
        message: 'invalid JSON: json: unknown field "note"',
      });
    }
  }

  /**
   * File a working copy of the key for its target, as the server does under
   * review. The change replaces the change of the pending proposal, which
   * keeps its id. A proposal whose base differs from the live object rebases.
   */
  private file(proposal: Omit<FakeProposal, "id">): PendingReview {
    const pending = this.proposals.get(proposal.target);
    let outcome = "created";
    if (pending && pending.base !== proposal.base) {
      outcome = "rebased";
    } else if (pending) {
      const same = JSON.stringify(proposal.change) === JSON.stringify(pending.change);
      outcome = same ? "unchanged" : "updated";
    }
    const filed = { ...proposal, id: pending?.id ?? this.nextProposalId++ };
    this.proposals.set(proposal.target, filed);
    return {
      id: filed.id,
      objectType: filed.objectType,
      summary: filed.summary,
      outcome,
      reviewUrl: `${REVIEW_URL}${filed.id}`,
    };
  }

  /** Withdraw the pending proposal of the key for target, if it has one. */
  private withdraw(target: string): void {
    const pending = this.proposals.get(target);
    if (!pending) return;
    this.proposals.delete(target);
    this.withdrawn.push(pending);
  }

  /** The permissions that GET /api/v1/me lists for the key. */
  private permissions(): string[] {
    const held: [boolean, string][] = [
      [true, "article.update"],
      [this.perms.articlePublish, "article.publish"],
      [this.perms.articlePlace, "article.place"],
      [this.perms.sectionCreate, "section.create"],
      [this.perms.changelogUpdate, "changelog.update"],
      [this.perms.changelogPublish, "changelog.publish"],
      [this.perms.changelogDelete, "changelog.delete"],
      [this.perms.openapiAttach, "openapi.attach"],
    ];
    return held.filter(([has]) => has).map(([, permission]) => permission);
  }

  async identity(): Promise<KeyIdentity> {
    this.enter("identity");
    if (this.legacy) {
      throw apiError("get me", 404, {
        code: "not_found",
        message: "no such endpoint: GET /api/v1/me",
      });
    }
    return { writes: this.writes ?? "", permissions: this.permissions() };
  }

  async listProposals(): Promise<RemoteProposal[]> {
    this.listProposalsCalls++;
    this.enter("listProposals");
    return [...this.proposals.values(), ...this.otherKeyProposals].map((p) => ({
      id: p.id,
      objectType: p.objectType,
      status: "pending",
      target: p.target,
      slug: p.slug,
      title: p.title,
    }));
  }

  seedArticle(a: Partial<StoredArticle> & { title: string; markdown: string }): string {
    const slug = a.slug ?? slugify(a.title);
    const section = a.section ?? "Guides";
    const nav = a.nav ?? slugify(section);
    if (!unplaced(nav) && !this.sections.has(nav)) this.sections.set(nav, section);
    this.articles.set(slug, {
      slug,
      title: a.title,
      section,
      nav,
      status: a.status ?? "STABLE",
      encrypted: a.encrypted ?? false,
      source: a.source ?? "",
      markdown: a.markdown,
    });
    return slug;
  }

  seedChangelog(e: Partial<RemoteChangelog> & { title: string; markdown: string }): number {
    const id = this.nextId++;
    this.changelog.push({
      id,
      title: e.title,
      markdown: e.markdown,
      tags: e.tags ?? [],
      status: e.status ?? "published",
      publishedAt: e.publishedAt ?? null,
    });
    return id;
  }

  async listArticles(): Promise<RemoteArticle[]> {
    this.enter("listArticles");
    return [...this.articles.values()].map(({ markdown: _m, ...row }) =>
      this.legacy ? { ...row, source: "" } : row,
    );
  }

  async listSections(): Promise<RemoteSection[]> {
    this.enter("listSections");
    if (this.legacy) {
      throw apiError("list sections", 404, {
        code: "not_found",
        message: "no such endpoint: GET /api/v1/workspaces/-/sections",
      });
    }
    return [...this.sections].map(([key, label]) => ({ key, label }));
  }

  async getArticleMarkdown(_ws: string | undefined, slug: string): Promise<string> {
    this.enter("getArticleMarkdown");
    const a = this.articles.get(slug);
    if (!a) throw apiError("get article", 404, { code: "not_found", message: "no such article" });
    return a.markdown;
  }

  async createArticle(_ws: string | undefined, args: CreateArticleArgs): Promise<CreatedArticle> {
    this.createArticleCalls.push({ ...args });
    const key = args.sectionKey;
    this.enter("createArticle", `create ${args.title}${key ? ` section_key=${key}` : ""}`);
    if (key !== undefined) {
      if (this.legacy) {
        throw apiError("create article", 400, {
          code: "invalid_body",
          message: 'invalid JSON: json: unknown field "section_key"',
        });
      }
      if (!this.sections.has(key)) {
        throw apiError("create article", 400, {
          code: "invalid_request",
          message: `unknown section key: ${key}`,
          details: { field: "section_key", allowed: [...this.sections.keys()] },
        });
      }
    }
    const requested = args.slug ? slugify(args.slug) : "";
    if (requested && this.articles.has(requested) && !this.legacy) {
      throw apiError("create article", 409, {
        code: "slug_taken",
        message: `the slug ${requested} is taken`,
        details: { slug: requested },
      });
    }
    const base = requested || slugify(args.title);
    let slug = base;
    for (let n = 2; this.articles.has(slug); n++) slug = `${base}-${n}`;
    const nav = key ?? "none";
    this.articles.set(slug, {
      slug,
      title: args.title,
      section: key ? (this.sections.get(key) as string) : (args.section ?? "Guides"),
      nav,
      status: "DRAFT",
      encrypted: false,
      source: "",
      markdown: args.markdown,
    });
    return { slug, nav: this.legacy ? "" : nav };
  }

  async updateArticle(
    _ws: string | undefined,
    args: UpdateArticleArgs,
  ): Promise<PendingReview | null> {
    this.updateArticleCalls.push({ ...args });
    const fields = [
      args.markdown !== undefined ? "markdown" : "",
      args.status !== undefined ? `status=${args.status}` : "",
      args.allowShrink ? "allow_shrink" : "",
    ].filter(Boolean);
    this.enter("updateArticle", `update ${args.slug} ${fields.join(" ")}`.trim());
    this.takeNote("update article", args.note);
    if (args.allowShrink && this.legacy) {
      throw apiError("update article", 400, {
        code: "invalid_body",
        message: 'invalid JSON: json: unknown field "allow_shrink"',
      });
    }
    if (args.status !== undefined && !this.perms.articlePublish) {
      throw this.denied(
        "update article",
        "article.publish",
        "article.publish is required to change status",
      );
    }
    const a = this.articles.get(args.slug);
    if (!a)
      throw apiError("update article", 404, { code: "not_found", message: "no such article" });
    if (a.source === "openapi") {
      throw apiError("update article", 409, {
        code: "openapi_generated",
        message: "detach this OpenAPI-generated page before editing it",
      });
    }
    // Under review, a change to a live article, a publish request, and a
    // change to an article with a pending proposal of the key apply to the
    // working copy of the key: its pending proposal, while that proposal
    // starts from the live article, else the live article.
    const target = `article:${a.slug}`;
    const pending = this.proposals.get(target);
    const publishes = args.status !== undefined && PUBLISHED_STATUSES.has(args.status);
    const reviewed =
      this.writes === "review" && (liveArticle(a) || publishes || pending !== undefined);
    const live = articleState(a);
    const base = JSON.stringify(live);
    let working = { ...live };
    let textCopy: FakeProposal | undefined;
    if (reviewed && pending && pending.base === base) {
      working = { ...live, ...(pending.change as Partial<ArticleState>) };
      if ("markdown" in pending.change) textCopy = pending;
    }
    if (args.markdown !== undefined && !args.allowShrink && !this.legacy) {
      const current = codePoints(working.markdown);
      const removed = current - codePoints(args.markdown);
      if (removed > LARGE_REMOVAL_CHARS && 2 * removed > current) {
        const message = `the new markdown removes ${removed} of the ${current} characters of the article. Send edits for a small change, or pass allow_shrink to replace the body`;
        throw apiError("update article", 422, {
          code: "large_removal",
          message: textCopy
            ? `${message}. The edits apply to the pending proposal of this key, which holds its earlier changes.`
            : message,
          details: textCopy
            ? { proposalId: textCopy.id, removed, currentLength: current }
            : { removed, currentLength: current },
        });
      }
    }
    if (reviewed) {
      for (const key of ARTICLE_FIELDS) {
        const value = args[key];
        if (value !== undefined) working[key] = value;
      }
      let changes = ARTICLE_FIELDS.filter((key) => working[key] !== live[key]);
      // A working copy that readers would not see saves at once, and one that
      // equals the live article changes nothing. Both withdraw the proposal.
      if (changes.length === 0 || !(liveArticle(a) || PUBLISHED_STATUSES.has(working.status))) {
        Object.assign(a, working);
        this.withdraw(target);
        return null;
      }
      // A publish request of a draft always holds its title and its text.
      if (!liveArticle(a)) {
        changes = ARTICLE_FIELDS.filter(
          (key) => key === "title" || key === "markdown" || changes.includes(key),
        );
      }
      return this.file({
        objectType: "article",
        target,
        slug: a.slug,
        title: working.title,
        summary:
          !liveArticle(a) && PUBLISHED_STATUSES.has(working.status)
            ? `Publish ${a.slug}: ${a.status} to ${working.status}`
            : `Change ${a.slug}: ${changes.join(", ")}`,
        change: Object.fromEntries(changes.map((key) => [key, working[key]])),
        base,
      });
    }
    if (args.title !== undefined) a.title = args.title;
    if (args.section !== undefined) a.section = args.section;
    if (args.markdown !== undefined) a.markdown = args.markdown;
    if (args.status !== undefined) a.status = args.status;
    // The contract places an unplaced article in the first section when a
    // status change publishes it.
    if (!this.legacy && args.status && PUBLISHED_STATUSES.has(args.status) && unplaced(a.nav)) {
      if (this.sections.size === 0) this.sections.set("documentation", "Documentation");
      const [first, label] = [...this.sections.entries()][0];
      a.nav = first;
      a.section = label;
    }
    return null;
  }

  async createSection(_ws: string | undefined, label: string): Promise<string> {
    this.createSectionCalls.push(label);
    this.enter("createSection", `section ${label}`);
    if (!this.perms.sectionCreate) throw this.denied("create section", "section.create");
    const wanted = label.trim().toLowerCase();
    if (!this.legacy) {
      for (const [key, existing] of this.sections) {
        if (existing.trim().toLowerCase() === wanted) return key;
      }
    }
    const base = slugify(label) || "section";
    let key = base;
    for (let n = 2; this.sections.has(key); n++) key = `${base}-${n}`;
    this.sections.set(key, label.trim());
    return key;
  }

  async placeArticle(
    _ws: string | undefined,
    slug: string,
    sectionKey: string,
    note?: string,
  ): Promise<PendingReview | null> {
    this.enter("placeArticle", `place ${slug} ${sectionKey}`);
    this.takeNote("place article", note);
    if (!this.perms.articlePlace) throw this.denied("place article", "article.place");
    const a = this.articles.get(slug);
    if (!a) throw apiError("place article", 404, { code: "not_found", message: "no such article" });
    if (!unplaced(sectionKey) && !this.sections.has(sectionKey)) {
      throw apiError("place article", 400, {
        code: "invalid_request",
        message: `no such section: ${sectionKey}`,
        details: { allowed: [...this.sections.keys()] },
      });
    }
    // Under review, a move of a live article files a placement proposal. A
    // move of a draft and a move into the section that holds the article
    // withdraw the pending placement proposal of the key.
    const target = `placement:${slug}`;
    if (this.writes === "review" && (liveArticle(a) || this.proposals.has(target))) {
      const from = unplaced(a.nav) ? "none" : a.nav;
      const stays = sectionKey === from;
      if (!liveArticle(a) || stays) {
        if (!stays) this.move(a, sectionKey);
        this.withdraw(target);
        return null;
      }
      return this.file({
        objectType: "placement",
        target,
        slug,
        title: a.title,
        summary: `Move ${slug} from ${a.nav} to ${sectionKey}`,
        change: { section: sectionKey },
        base: from,
      });
    }
    this.move(a, sectionKey);
    return null;
  }

  private move(a: StoredArticle, sectionKey: string): void {
    a.nav = sectionKey;
    a.section = unplaced(sectionKey) ? "Unlisted" : (this.sections.get(sectionKey) as string);
  }

  async listChangelog(
    _ws: string | undefined,
    query: ChangelogListQuery,
  ): Promise<RemoteChangelog[]> {
    this.changelogListCalls.push({ ...query });
    this.enter("listChangelog");
    const copy = (e: RemoteChangelog) => ({ ...e, tags: [...e.tags] });
    if (this.legacy) {
      const drafts = query.drafts && this.perms.changelogUpdate;
      return this.changelog
        .filter((e) => drafts || live(e))
        .sort(changelogOrder)
        .slice(0, 50)
        .map(copy);
    }
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw apiError("list changelog", 400, {
        code: "invalid_request",
        message: "limit must be between 1 and 100",
        details: { field: "limit" },
      });
    }
    if (!Number.isInteger(offset) || offset < 0) {
      throw apiError("list changelog", 400, {
        code: "invalid_request",
        message: "offset must be 0 or more",
        details: { field: "offset" },
      });
    }
    if (query.drafts && !this.perms.changelogUpdate) {
      throw permissionDenied("list changelog", "changelog.update");
    }
    const start = this.ignoreOffset ? 0 : offset;
    return this.changelog
      .filter((e) => query.drafts || live(e))
      .sort(changelogOrder)
      .slice(start, start + limit)
      .map(copy);
  }

  async createChangelog(
    _ws: string | undefined,
    args: CreateChangelogArgs,
  ): Promise<PendingReview | null> {
    this.sentTags.push([...(args.tags ?? [])]);
    this.enter("createChangelog", `create changelog ${args.title}`);
    this.takeNote("create changelog", args.note);
    const status = args.status ?? "draft";
    if (status === "published" && !this.perms.changelogPublish) {
      throw this.denied(
        "create changelog",
        "changelog.publish",
        "changelog.publish is required to publish",
      );
    }
    const tags = this.normalizeTags("create changelog", args.tags ?? []);
    const entry = {
      title: args.title,
      markdown: args.markdown,
      tags,
      status,
      publishedAt: args.publishedAt ?? null,
    };
    if (this.writes === "review" && status === "published") {
      const normalized = args.title.trim().toLowerCase().split(/\s+/).join(" ");
      return this.file({
        objectType: "changelog",
        target: `changelog-new:${normalized}`,
        slug: "",
        title: args.title,
        summary: `Publish changelog entry: ${args.title}`,
        change: { action: "create", ...entry },
        base: "",
      });
    }
    this.seedChangelog(entry);
    return null;
  }

  async updateChangelog(
    _ws: string | undefined,
    args: UpdateChangelogArgs,
  ): Promise<PendingReview | null> {
    if (args.tags !== undefined) this.sentTags.push([...args.tags]);
    this.enter("updateChangelog", `update changelog ${args.id}`);
    this.takeNote("update changelog", args.note);
    if (!this.perms.changelogUpdate) throw this.denied("update changelog", "changelog.update");
    const tags =
      args.tags === undefined ? undefined : this.normalizeTags("update changelog", args.tags);
    if (args.status !== undefined && !this.perms.changelogPublish) {
      throw this.denied(
        "update changelog",
        "changelog.publish",
        "changelog.publish is required to change status",
      );
    }
    const e = this.changelog.find((c) => c.id === args.id);
    if (!e) {
      throw apiError("update changelog", 404, {
        code: "not_found",
        message: "no such changelog entry",
      });
    }
    // Under review, the change applies to the working copy of the key, as
    // for articles. A pending delete is not a working copy of the text, so a
    // change that equals the live entry withdraws it too.
    const target = `changelog:${e.id}`;
    const pending = this.proposals.get(target);
    if (
      this.writes === "review" &&
      (e.status === "published" || args.status === "published" || pending !== undefined)
    ) {
      const live = entryState(e);
      const base = JSON.stringify(live);
      let working = { ...live };
      if (pending && pending.change.action === "update" && pending.base === base) {
        const { action: _action, ...fields } = pending.change;
        working = { ...live, ...(fields as Partial<EntryState>) };
      }
      if (args.markdown !== undefined) working.markdown = args.markdown;
      if (tags !== undefined) working.tags = tags;
      if (args.publishedAt !== undefined) working.publishedAt = args.publishedAt;
      if (args.status !== undefined) working.status = args.status;
      const changes = entryChanges(working, live);
      if (
        changes.length === 0 ||
        !(live.status === "published" || working.status === "published")
      ) {
        Object.assign(e, working);
        this.withdraw(target);
        return null;
      }
      return this.file({
        objectType: "changelog",
        target,
        slug: "",
        title: working.title,
        summary:
          e.status !== "published" && working.status === "published"
            ? `Publish changelog entry: ${e.title}`
            : `Change changelog entry: ${e.title}`,
        change: {
          action: "update",
          ...Object.fromEntries(
            changes.map((field) => [field, working[field as keyof EntryState]]),
          ),
        },
        base,
      });
    }
    if (args.markdown !== undefined) e.markdown = args.markdown;
    if (tags !== undefined) e.tags = tags;
    if (args.publishedAt !== undefined) e.publishedAt = args.publishedAt;
    if (args.status !== undefined) e.status = args.status;
    return null;
  }

  async deleteChangelog(
    _ws: string | undefined,
    id: number,
    note?: string,
  ): Promise<PendingReview | null> {
    this.enter("deleteChangelog", `delete changelog ${id}`);
    this.takeNote("delete changelog", note, false);
    if (!this.perms.changelogDelete) throw this.denied("delete changelog", "changelog.delete");
    const e = this.changelog.find((c) => c.id === id);
    if (!e) {
      throw apiError("delete changelog", 404, {
        code: "not_found",
        message: "no such changelog entry",
      });
    }
    // Under review, the delete of a published entry replaces the working copy
    // of the key. The delete of a draft applies and withdraws it.
    const target = `changelog:${id}`;
    if (this.writes === "review" && (e.status === "published" || this.proposals.has(target))) {
      if (e.status === "published") {
        return this.file({
          objectType: "changelog",
          target,
          slug: "",
          title: e.title,
          summary: `Delete changelog entry: ${e.title}`,
          change: { action: "delete" },
          base: JSON.stringify(entryState(e)),
        });
      }
      this.withdraw(target);
    }
    this.changelog = this.changelog.filter((c) => c.id !== id);
    return null;
  }

  async attachOpenapi(
    _ws: string | undefined,
    spec: string,
    note?: string,
  ): Promise<OpenapiAttachResult> {
    this.enter("attachOpenapi", "attach openapi");
    this.takeNote("attach OpenAPI", note);
    if (!this.perms.openapiAttach) throw this.denied("attach OpenAPI", "openapi.attach");
    if (this.legacy && !this.planIncludesOpenapi) throw legacyUpgradeRequired("attach OpenAPI");
    // A spec that is up to date withdraws the pending proposal of the key.
    if (!this.legacy && spec === this.openapiSpec) {
      if (this.writes === "review") this.withdraw("openapi");
      return { stats: null, unchanged: true, review: null };
    }
    if (this.writes === "review") {
      const s = this.openapiStats;
      const review = this.file({
        objectType: "openapi",
        target: "openapi",
        slug: "",
        title: "",
        summary: `Attach the API reference: ${s.created} new, ${s.updated} changed, ${s.deleted} removed`,
        change: { spec },
        base: this.openapiSpec ?? "",
      });
      return { stats: null, unchanged: false, review };
    }
    this.openapiSpec = spec;
    return { stats: { ...this.openapiStats }, unchanged: false, review: null };
  }
}

/**
 * The review state that runSync reads at the start of a run against the
 * fake: the permissions of the key and its pending proposals.
 */
export async function reviewState(cowl: FakeCowl): Promise<ReviewState> {
  const { permissions } = await cowl.identity();
  return {
    articlePublish: permissions.includes("article.publish"),
    pending: pendingProposals(await cowl.listProposals()),
  };
}
