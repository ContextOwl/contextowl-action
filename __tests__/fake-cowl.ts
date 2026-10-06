// In-memory Cowl gateway for tests. By default it follows the REST contract:
// canonical changelog tags with their aliases, limit and offset paging, and the
// real 402 and 403 error bodies, built by the same parser the REST client uses.
// `legacy: true` simulates a server from before the contract.
import { errorFromResponse } from "../src/api/client.js";
import type {
  ChangelogListQuery,
  Cowl,
  CowlAPIError,
  CreateArticleArgs,
  CreateChangelogArgs,
  CreatedArticle,
  OpenapiAttachResult,
  OpenapiStats,
  RemoteArticle,
  RemoteChangelog,
  RemoteSection,
  UpdateArticleArgs,
  UpdateChangelogArgs,
} from "../src/types.js";

interface StoredArticle extends RemoteArticle {
  markdown: string;
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
  perms: FakePerms = {
    articlePublish: true,
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

  async updateArticle(_ws: string | undefined, args: UpdateArticleArgs): Promise<void> {
    this.updateArticleCalls.push({ ...args });
    const fields = [
      args.markdown !== undefined ? "markdown" : "",
      args.status !== undefined ? `status=${args.status}` : "",
      args.allowShrink ? "allow_shrink" : "",
    ].filter(Boolean);
    this.enter("updateArticle", `update ${args.slug} ${fields.join(" ")}`.trim());
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
    if (args.markdown !== undefined && !args.allowShrink && !this.legacy) {
      const removed = a.markdown.length - args.markdown.length;
      if (removed > a.markdown.length / 2 && removed > 2000) {
        throw apiError("update article", 422, {
          code: "large_removal",
          message: `this body removes ${removed} of ${a.markdown.length} characters`,
          details: { removed, currentLength: a.markdown.length },
        });
      }
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

  async placeArticle(_ws: string | undefined, slug: string, sectionKey: string): Promise<void> {
    this.enter("placeArticle", `place ${slug} ${sectionKey}`);
    const a = this.articles.get(slug);
    if (!a) throw apiError("place article", 404, { code: "not_found", message: "no such article" });
    if (!unplaced(sectionKey) && !this.sections.has(sectionKey)) {
      throw apiError("place article", 400, {
        code: "invalid_request",
        message: `no such section: ${sectionKey}`,
        details: { allowed: [...this.sections.keys()] },
      });
    }
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

  async createChangelog(_ws: string | undefined, args: CreateChangelogArgs): Promise<number> {
    this.sentTags.push([...(args.tags ?? [])]);
    this.enter("createChangelog", `create changelog ${args.title}`);
    const status = args.status ?? "draft";
    if (status === "published" && !this.perms.changelogPublish) {
      throw this.denied(
        "create changelog",
        "changelog.publish",
        "changelog.publish is required to publish",
      );
    }
    const tags = this.normalizeTags("create changelog", args.tags ?? []);
    return this.seedChangelog({
      title: args.title,
      markdown: args.markdown,
      tags,
      status,
      publishedAt: args.publishedAt ?? null,
    });
  }

  async updateChangelog(_ws: string | undefined, args: UpdateChangelogArgs): Promise<void> {
    if (args.tags !== undefined) this.sentTags.push([...args.tags]);
    this.enter("updateChangelog", `update changelog ${args.id}`);
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
    if (args.markdown !== undefined) e.markdown = args.markdown;
    if (tags !== undefined) e.tags = tags;
    if (args.publishedAt !== undefined) e.publishedAt = args.publishedAt;
    if (args.status !== undefined) e.status = args.status;
  }

  async deleteChangelog(_ws: string | undefined, id: number): Promise<void> {
    this.enter("deleteChangelog", `delete changelog ${id}`);
    if (!this.perms.changelogDelete) throw this.denied("delete changelog", "changelog.delete");
    if (!this.changelog.some((c) => c.id === id)) {
      throw apiError("delete changelog", 404, {
        code: "not_found",
        message: "no such changelog entry",
      });
    }
    this.changelog = this.changelog.filter((c) => c.id !== id);
  }

  async attachOpenapi(_ws: string | undefined, spec: string): Promise<OpenapiAttachResult> {
    this.enter("attachOpenapi", "attach openapi");
    if (!this.perms.openapiAttach) throw this.denied("attach OpenAPI", "openapi.attach");
    if (this.legacy && !this.planIncludesOpenapi) throw legacyUpgradeRequired("attach OpenAPI");
    if (!this.legacy && spec === this.openapiSpec) return { stats: null, unchanged: true };
    this.openapiSpec = spec;
    return { stats: { ...this.openapiStats }, unchanged: false };
  }
}
