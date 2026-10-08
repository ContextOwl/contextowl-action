import {
  type ChangelogListQuery,
  type Cowl,
  type CreateArticleArgs,
  type CreateChangelogArgs,
  type CreatedArticle,
  type KeyIdentity,
  type OpenapiAttachResult,
  type OpenapiStats,
  type PendingReview,
  type RemoteArticle,
  type RemoteChangelog,
  type RemoteSection,
  type UpdateArticleArgs,
  type UpdateChangelogArgs,
  CowlAPIError,
} from "../types.js";
import { asArray, bool, isRec, lc, num, str, strArray } from "../util/json.js";
import { USER_AGENT } from "../version.js";

/** Attempts per request when the server answers 429, or 502 to 504 for a GET. */
const MAX_ATTEMPTS = 4;
const MAX_RETRY_DELAY_MS = 30_000;

export interface RestClientOptions {
  /** Waits between retries. Tests replace it to skip the delay. */
  sleep?: (ms: number) => Promise<void>;
}

export class RestClient implements Cowl {
  private sleep: (ms: number) => Promise<void>;

  constructor(
    private apiUrl: string,
    private token: string,
    options: RestClientOptions = {},
  ) {
    this.sleep = options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  }

  private workspacePath(workspace: string | undefined): string {
    return `workspaces/${encodeURIComponent(workspace || "-")}`;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    return (await this.exchange(method, path, body)).data as T;
  }

  /**
   * Send a write that can wait for review. The server answers 202 when the
   * organization reviews agent changes, and the body then holds the proposal.
   */
  private async write(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<{ data: unknown; review: PendingReview | null }> {
    const { status, data } = await this.exchange(method, path, body);
    return { data, review: status === 202 ? pendingReviewOf(data) : null };
  }

  /** Send a request. Returns the status and the parsed body of a 2xx answer. */
  private async exchange(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<{ status: number; data: unknown }> {
    const operation = `${method} ${path}`;
    const response = await this.send(operation, `${this.apiUrl}/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/json",
        "User-Agent": USER_AGENT,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    const text = await response.text();
    if (!response.ok) {
      throw errorFromResponse(operation, response.status, text, response.statusText);
    }
    if (!text) return { status: response.status, data: null };
    try {
      return { status: response.status, data: JSON.parse(text) };
    } catch {
      throw new CowlAPIError(operation, "invalid JSON response", response.status);
    }
  }

  // The rate limiter answers 429 before the handler runs, so a retry never
  // repeats a write. A 5xx can come after a write, so only a GET retries it.
  private async send(operation: string, url: string, init: RequestInit): Promise<Response> {
    for (let attempt = 1; ; attempt++) {
      let response: Response;
      try {
        response = await fetch(url, init);
      } catch (err) {
        throw new CowlAPIError(operation, `request failed: ${(err as Error).message}`);
      }
      if (attempt >= MAX_ATTEMPTS || !shouldRetry(init.method ?? "GET", response.status)) {
        return response;
      }
      await response.arrayBuffer().catch(() => undefined);
      await this.sleep(retryDelayMs(response.headers.get("Retry-After"), attempt));
    }
  }

  async identity(): Promise<KeyIdentity> {
    const data = await this.request<unknown>("GET", "me");
    return { writes: isRec(data) ? str(lc(data).writes) : "" };
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
          source: str(r.source),
        };
      });
  }

  async listSections(workspace: string | undefined): Promise<RemoteSection[]> {
    const data = await this.request<unknown>("GET", `${this.workspacePath(workspace)}/sections`);
    return asArray(data)
      .filter(isRec)
      .map((row) => {
        const r = lc(row);
        return { key: str(r.key), label: str(r.label) };
      });
  }

  async getArticleMarkdown(workspace: string | undefined, slug: string): Promise<string> {
    const data = await this.request<unknown>(
      "GET",
      `${this.workspacePath(workspace)}/articles/${encodeURIComponent(slug)}`,
    );
    return isRec(data) ? str(lc(data).markdown) : "";
  }

  async createArticle(
    workspace: string | undefined,
    args: CreateArticleArgs,
  ): Promise<CreatedArticle> {
    const data = await this.request<unknown>("POST", `${this.workspacePath(workspace)}/articles`, {
      title: args.title,
      slug: args.slug,
      section: args.section,
      section_key: args.sectionKey,
      markdown: args.markdown,
    });
    const rec = isRec(data) ? lc(data) : {};
    const slug = str(rec.slug);
    if (!slug) throw new CowlAPIError("create article", "no slug returned");
    return { slug, nav: str(rec.nav) };
  }

  async updateArticle(
    workspace: string | undefined,
    args: UpdateArticleArgs,
  ): Promise<PendingReview | null> {
    const { review } = await this.write(
      "PATCH",
      `${this.workspacePath(workspace)}/articles/${encodeURIComponent(args.slug)}`,
      {
        title: args.title,
        section: args.section,
        markdown: args.markdown,
        status: args.status,
        allow_shrink: args.allowShrink || undefined,
        note: args.note,
      },
    );
    return review;
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
    note?: string,
  ): Promise<PendingReview | null> {
    const { review } = await this.write(
      "POST",
      `${this.workspacePath(workspace)}/articles/${encodeURIComponent(slug)}/placement`,
      { section: sectionKey, note },
    );
    return review;
  }

  async listChangelog(
    workspace: string | undefined,
    query: ChangelogListQuery,
  ): Promise<RemoteChangelog[]> {
    const params = new URLSearchParams();
    if (query.drafts) params.set("drafts", "true");
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    if (query.offset !== undefined) params.set("offset", String(query.offset));
    const search = params.toString();
    const data = await this.request<unknown>(
      "GET",
      `${this.workspacePath(workspace)}/changelog${search ? `?${search}` : ""}`,
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

  async createChangelog(
    workspace: string | undefined,
    args: CreateChangelogArgs,
  ): Promise<PendingReview | null> {
    const { review } = await this.write("POST", `${this.workspacePath(workspace)}/changelog`, {
      title: args.title,
      markdown: args.markdown,
      tags: args.tags,
      status: args.status,
      published_at: args.publishedAt,
      note: args.note,
    });
    return review;
  }

  async updateChangelog(
    workspace: string | undefined,
    args: UpdateChangelogArgs,
  ): Promise<PendingReview | null> {
    const { review } = await this.write(
      "PATCH",
      `${this.workspacePath(workspace)}/changelog/${args.id}`,
      {
        title: args.title,
        markdown: args.markdown,
        tags: args.tags,
        status: args.status,
        published_at: args.publishedAt,
        note: args.note,
      },
    );
    return review;
  }

  // A DELETE has no body, so the note is a query parameter. Servers without
  // the review ignore an unknown query parameter.
  async deleteChangelog(
    workspace: string | undefined,
    id: number,
    note?: string,
  ): Promise<PendingReview | null> {
    const query = note ? `?${new URLSearchParams({ note })}` : "";
    const { review } = await this.write(
      "DELETE",
      `${this.workspacePath(workspace)}/changelog/${id}${query}`,
    );
    return review;
  }

  async attachOpenapi(
    workspace: string | undefined,
    spec: string,
    note?: string,
  ): Promise<OpenapiAttachResult> {
    const { data, review } = await this.write("PUT", `${this.workspacePath(workspace)}/openapi`, {
      spec,
      note,
    });
    return { stats: statsOf(data), unchanged: isRec(data) && lc(data).unchanged === true, review };
  }
}

/** Read the proposal from the body of a 202 answer. Every field is optional. */
function pendingReviewOf(data: unknown): PendingReview {
  const body = isRec(data) ? lc(data) : {};
  const proposal = isRec(body.proposal) ? lc(body.proposal) : {};
  return {
    id: num(proposal.id),
    objectType: str(proposal.objecttype),
    summary: str(proposal.summary),
    outcome: str(proposal.outcome),
    reviewUrl: str(proposal.reviewurl),
  };
}

/**
 * Build the error for a failed response from its status and body text. The
 * body is the REST error envelope: `{"error":{"code","message","status","details"}}`.
 */
export function errorFromResponse(
  operation: string,
  status: number,
  text: string,
  statusText = "",
): CowlAPIError {
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  const error = isRec(data) && isRec(data.error) ? lc(data.error) : {};
  return new CowlAPIError(
    operation,
    str(error.message) || statusText || `request failed with status ${status}`,
    status,
    str(error.code) || undefined,
    isRec(error.details) ? error.details : {},
  );
}

function shouldRetry(method: string, status: number): boolean {
  if (status === 429) return true;
  return method === "GET" && (status === 502 || status === 503 || status === 504);
}

function retryDelayMs(retryAfter: string | null, attempt: number): number {
  const seconds = retryAfter !== null && /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter) : NaN;
  const ms = Number.isNaN(seconds) ? 1000 * 2 ** (attempt - 1) : seconds * 1000;
  return Math.min(ms, MAX_RETRY_DELAY_MS);
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
