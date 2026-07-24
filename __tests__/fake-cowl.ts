// In-memory Cowl gateway for tests. Mirrors REST API semantics without network access.
import {
  type Cowl,
  type CreateArticleArgs,
  type CreateChangelogArgs,
  type OpenapiStats,
  type RemoteArticle,
  type RemoteChangelog,
  type UpdateArticleArgs,
  type UpdateChangelogArgs,
  CowlAPIError,
} from "../src/types.js";

interface StoredArticle extends RemoteArticle {
  markdown: string;
  openapi?: boolean;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface FakePerms {
  articlePublish: boolean;
  changelogPublish: boolean;
  changelogDelete: boolean;
  openapiAttach: boolean;
}

export class FakeCowl implements Cowl {
  articles = new Map<string, StoredArticle>();
  sections = new Map<string, string>(); // key -> label
  changelog: (RemoteChangelog & {})[] = [];
  private nextId = 1;
  openapiSpec: string | null = null;
  openapiStats: OpenapiStats = { created: 0, updated: 0, deleted: 0 };
  perms: FakePerms = {
    articlePublish: true,
    changelogPublish: true,
    changelogDelete: true,
    openapiAttach: true,
  };

  seedArticle(a: Partial<StoredArticle> & { title: string; markdown: string }): string {
    const slug = a.slug ?? slugify(a.title);
    this.articles.set(slug, {
      slug,
      title: a.title,
      section: a.section ?? "Guides",
      nav: a.nav ?? "guides",
      status: a.status ?? "STABLE",
      encrypted: a.encrypted ?? false,
      markdown: a.markdown,
      openapi: a.openapi,
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
    return [...this.articles.values()].map(({ markdown: _m, openapi: _o, ...row }) => row);
  }

  async getArticleMarkdown(_ws: string | undefined, slug: string): Promise<string> {
    const a = this.articles.get(slug);
    if (!a) throw new CowlAPIError("get article", "no such article", 404, "not_found");
    return a.markdown;
  }

  async createArticle(_ws: string | undefined, args: CreateArticleArgs): Promise<string> {
    let slug = slugify(args.title);
    let n = 2;
    while (this.articles.has(slug)) slug = `${slugify(args.title)}-${n++}`;
    this.articles.set(slug, {
      slug,
      title: args.title,
      section: args.section ?? "Guides",
      nav: "",
      status: "DRAFT",
      encrypted: false,
      markdown: args.markdown,
    });
    return slug;
  }

  async updateArticle(_ws: string | undefined, args: UpdateArticleArgs): Promise<void> {
    const a = this.articles.get(args.slug);
    if (!a) throw new CowlAPIError("update article", "no such article", 404, "not_found");
    if (a.openapi) {
      throw new CowlAPIError(
        "update article",
        "detach this OpenAPI-generated page before editing it",
        409,
        "openapi_generated",
      );
    }
    if (args.status !== undefined && !this.perms.articlePublish) {
      throw new CowlAPIError(
        "update article",
        "article.publish is required to change status",
        403,
        "permission_denied",
      );
    }
    if (args.title !== undefined) a.title = args.title;
    if (args.section !== undefined) a.section = args.section;
    if (args.markdown !== undefined) a.markdown = args.markdown;
    if (args.status !== undefined) a.status = args.status;
  }

  async createSection(_ws: string | undefined, label: string): Promise<string> {
    const key = slugify(label);
    this.sections.set(key, label);
    return key;
  }

  async placeArticle(_ws: string | undefined, slug: string, sectionKey: string): Promise<void> {
    const a = this.articles.get(slug);
    if (a) a.nav = sectionKey;
  }

  async listChangelog(_ws: string | undefined, drafts: boolean): Promise<RemoteChangelog[]> {
    return this.changelog.filter((e) => drafts || e.status === "published").map((e) => ({ ...e }));
  }

  async createChangelog(_ws: string | undefined, args: CreateChangelogArgs): Promise<number> {
    if (args.status === "published" && !this.perms.changelogPublish) {
      throw new CowlAPIError(
        "create changelog",
        "changelog.publish is required to publish",
        403,
        "permission_denied",
      );
    }
    return this.seedChangelog({
      title: args.title,
      markdown: args.markdown,
      tags: args.tags ?? [],
      status: args.status ?? "draft",
      publishedAt: args.publishedAt ?? null,
    });
  }

  async updateChangelog(_ws: string | undefined, args: UpdateChangelogArgs): Promise<void> {
    const e = this.changelog.find((c) => c.id === args.id);
    if (!e) throw new CowlAPIError("update changelog", "no such changelog entry", 404, "not_found");
    if (args.status !== undefined && !this.perms.changelogPublish) {
      throw new CowlAPIError(
        "update changelog",
        "changelog.publish is required to change status",
        403,
        "permission_denied",
      );
    }
    if (args.markdown !== undefined) e.markdown = args.markdown;
    if (args.tags !== undefined) e.tags = args.tags;
    if (args.publishedAt !== undefined) e.publishedAt = args.publishedAt;
    if (args.status !== undefined) e.status = args.status;
  }

  async deleteChangelog(_ws: string | undefined, id: number): Promise<void> {
    if (!this.perms.changelogDelete) {
      throw new CowlAPIError(
        "delete changelog",
        "changelog.delete is required",
        403,
        "permission_denied",
      );
    }
    this.changelog = this.changelog.filter((c) => c.id !== id);
  }

  async attachOpenapi(_ws: string | undefined, spec: string): Promise<OpenapiStats | null> {
    if (!this.perms.openapiAttach) {
      throw new CowlAPIError(
        "attach OpenAPI",
        "openapi.attach is required",
        403,
        "permission_denied",
      );
    }
    this.openapiSpec = spec;
    return this.openapiStats;
  }
}
