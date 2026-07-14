// Real Cowl gateway: talks to a ContextOwl instance over the MCP Streamable
// HTTP transport, authenticated with a personal access token.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  type Cowl,
  type CreateArticleArgs,
  type CreateChangelogArgs,
  type OpenapiStats,
  type RemoteArticle,
  type RemoteChangelog,
  type UpdateArticleArgs,
  type UpdateChangelogArgs,
  CowlToolError,
} from "../types.js";
import { type Rec, asArray, bool, isRec, lc, num, str, strArray } from "../util/json.js";

interface CallToolResultLike {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

/** Drop undefined values so optional tool args are omitted, not sent as null. */
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

export class CowlClient implements Cowl {
  private client: Client;
  private transport: StreamableHTTPClientTransport;

  constructor(mcpUrl: string, token: string) {
    this.transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    this.client = new Client({ name: "contextowl-action", version: "1.0.0" });
  }

  async connect(): Promise<void> {
    await this.client.connect(this.transport);
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  private async call(name: string, args: Record<string, unknown>): Promise<CallToolResultLike> {
    const res = (await this.client.callTool({
      name,
      arguments: compact(args),
    })) as CallToolResultLike;
    if (res.isError) throw new CowlToolError(name, textOf(res) || "tool error");
    return res;
  }

  private async callJson(name: string, args: Record<string, unknown>): Promise<unknown> {
    const res = await this.call(name, args);
    if (res.structuredContent !== undefined && res.structuredContent !== null) {
      return res.structuredContent;
    }
    const text = textOf(res);
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  }

  async listArticles(workspace: string | undefined): Promise<RemoteArticle[]> {
    const data = await this.callJson("list_articles", { workspace });
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
    const res = await this.call("get_article", { workspace, slug });
    return textOf(res);
  }

  async createArticle(workspace: string | undefined, args: CreateArticleArgs): Promise<string> {
    const data = await this.callJson("create_article", {
      workspace,
      title: args.title,
      section: args.section,
      markdown: args.markdown,
    });
    const slug = isRec(data) ? str(lc(data).slug) : "";
    if (!slug) throw new CowlToolError("create_article", "no slug returned");
    return slug;
  }

  async updateArticle(workspace: string | undefined, args: UpdateArticleArgs): Promise<void> {
    await this.call("update_article", {
      workspace,
      slug: args.slug,
      title: args.title,
      section: args.section,
      markdown: args.markdown,
      status: args.status,
      version: args.version,
    });
  }

  async createSection(workspace: string | undefined, label: string): Promise<string> {
    const data = await this.callJson("create_section", { workspace, label });
    const key = isRec(data) ? str(lc(data).key) : "";
    if (!key) throw new CowlToolError("create_section", "no section key returned");
    return key;
  }

  async placeArticle(
    workspace: string | undefined,
    slug: string,
    sectionKey: string,
  ): Promise<void> {
    await this.call("place_article", { workspace, slug, section: sectionKey });
  }

  async listChangelog(workspace: string | undefined, drafts: boolean): Promise<RemoteChangelog[]> {
    const data = await this.callJson("list_changelog", { workspace, drafts });
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
    const data = await this.callJson("create_changelog", {
      workspace,
      title: args.title,
      markdown: args.markdown,
      tags: args.tags,
      status: args.status,
      published_at: args.publishedAt,
    });
    return isRec(data) ? num(lc(data).id) : 0;
  }

  async updateChangelog(workspace: string | undefined, args: UpdateChangelogArgs): Promise<void> {
    await this.call("update_changelog", {
      workspace,
      id: args.id,
      title: args.title,
      markdown: args.markdown,
      tags: args.tags,
      status: args.status,
      published_at: args.publishedAt,
    });
  }

  async deleteChangelog(workspace: string | undefined, id: number): Promise<void> {
    await this.call("delete_changelog", { workspace, id });
  }

  async attachOpenapi(workspace: string | undefined, spec: string): Promise<OpenapiStats | null> {
    const data = await this.callJson("attach_openapi_spec", { workspace, spec });
    return statsOf(data);
  }
}

function textOf(res: CallToolResultLike): string {
  return (res.content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("");
}

/** Pull created/updated/deleted counts out of an OpenAPI sync result, if present. */
function statsOf(data: unknown): OpenapiStats | null {
  const rec: Rec | null = isRec(data) ? lc(data) : null;
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
