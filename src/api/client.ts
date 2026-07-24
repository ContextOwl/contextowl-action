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
} from "../types.js";
import { asArray, bool, isRec, lc, num, str, strArray } from "../util/json.js";

export class RestClient implements Cowl {
  constructor(
    private apiUrl: string,
    private token: string,
  ) {}

  private workspacePath(workspace: string | undefined): string {
    return `workspaces/${encodeURIComponent(workspace || "-")}`;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.apiUrl}/${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      throw new CowlAPIError(`${method} ${path}`, `request failed: ${(err as Error).message}`);
    }

    const text = await response.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        if (response.ok) {
          throw new CowlAPIError(`${method} ${path}`, "invalid JSON response", response.status);
        }
      }
    }
    if (!response.ok) {
      const error = isRec(data) && isRec(data.error) ? lc(data.error) : {};
      throw new CowlAPIError(
        `${method} ${path}`,
        str(error.message) ||
          response.statusText ||
          `request failed with status ${response.status}`,
        response.status,
        str(error.code),
      );
    }
    return data as T;
  }

  async listArticles(workspace: string | undefined): Promise<RemoteArticle[]> {
    const data = await this.request<unknown>("GET", `${this.workspacePath(workspace)}/articles`);
    return asArray(data)
      .filter(isRec)
      .map((row) => {
        const r = lc(row);
        return {
          slug: str(r.slug),
          title: str(r.title),
          section: str(r.section),
          nav: str(r.nav),
          status: str(r.status),
          encrypted: bool(r.encrypted),
        };
      });
  }

  async getArticleMarkdown(workspace: string | undefined, slug: string): Promise<string> {
    const data = await this.request<unknown>(
      "GET",
      `${this.workspacePath(workspace)}/articles/${encodeURIComponent(slug)}`,
    );
    return isRec(data) ? str(lc(data).markdown) : "";
  }

  async createArticle(workspace: string | undefined, args: CreateArticleArgs): Promise<string> {
    const data = await this.request<unknown>("POST", `${this.workspacePath(workspace)}/articles`, {
      title: args.title,
      slug: args.slug,
      section: args.section,
      markdown: args.markdown,
    });
    const slug = isRec(data) ? str(lc(data).slug) : "";
    if (!slug) throw new CowlAPIError("create article", "no slug returned");
    return slug;
  }

  async updateArticle(workspace: string | undefined, args: UpdateArticleArgs): Promise<void> {
    await this.request(
      "PATCH",
      `${this.workspacePath(workspace)}/articles/${encodeURIComponent(args.slug)}`,
      { title: args.title, section: args.section, markdown: args.markdown, status: args.status },
    );
  }

  async createSection(workspace: string | undefined, label: string): Promise<string> {
    const data = await this.request<unknown>("POST", `${this.workspacePath(workspace)}/sections`, {
      label,
    });
    const key = isRec(data) ? str(lc(data).key) : "";
    if (!key) throw new CowlAPIError("create section", "no section key returned");
    return key;
  }

  async placeArticle(
    workspace: string | undefined,
    slug: string,
    sectionKey: string,
  ): Promise<void> {
    await this.request(
      "POST",
      `${this.workspacePath(workspace)}/articles/${encodeURIComponent(slug)}/placement`,
      { section: sectionKey },
    );
  }

  async listChangelog(workspace: string | undefined, drafts: boolean): Promise<RemoteChangelog[]> {
    const data = await this.request<unknown>(
      "GET",
      `${this.workspacePath(workspace)}/changelog?drafts=${drafts}`,
    );
    return asArray(data)
      .filter(isRec)
      .map((row) => {
        const r = lc(row);
        return {
          id: num(r.id),
          title: str(r.title),
          markdown: str(r.markdown),
          tags: strArray(r.tags),
          status: str(r.status),
          publishedAt: typeof r.publishedat === "string" ? r.publishedat : null,
        };
      });
  }

  async createChangelog(workspace: string | undefined, args: CreateChangelogArgs): Promise<number> {
    const data = await this.request<unknown>("POST", `${this.workspacePath(workspace)}/changelog`, {
      title: args.title,
      markdown: args.markdown,
      tags: args.tags,
      status: args.status,
      published_at: args.publishedAt,
    });
    return isRec(data) ? num(lc(data).id) : 0;
  }

  async updateChangelog(workspace: string | undefined, args: UpdateChangelogArgs): Promise<void> {
    await this.request("PATCH", `${this.workspacePath(workspace)}/changelog/${args.id}`, {
      title: args.title,
      markdown: args.markdown,
      tags: args.tags,
      status: args.status,
      published_at: args.publishedAt,
    });
  }

  async deleteChangelog(workspace: string | undefined, id: number): Promise<void> {
    await this.request("DELETE", `${this.workspacePath(workspace)}/changelog/${id}`);
  }

  async attachOpenapi(workspace: string | undefined, spec: string): Promise<OpenapiStats | null> {
    const data = await this.request<unknown>("PUT", `${this.workspacePath(workspace)}/openapi`, {
      spec,
    });
    return statsOf(data);
  }
}

function statsOf(data: unknown): OpenapiStats | null {
  const rec = isRec(data) ? lc(data) : null;
  if (!rec) return null;
  const source = isRec(rec.stats) ? lc(rec.stats) : rec;
  if (
    source.created === undefined &&
    source.updated === undefined &&
    source.deleted === undefined
  ) {
    return null;
  }
  return {
    created: num(source.created),
    updated: num(source.updated),
    deleted: num(source.deleted),
  };
}
