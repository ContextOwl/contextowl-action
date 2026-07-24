import { afterEach, describe, expect, it, vi } from "vitest";
import { RestClient } from "../src/api/client.js";
import { CowlAPIError } from "../src/types.js";

interface RequestCall {
  url: string;
  method: string;
  body: string | undefined;
  authorization: string | null;
}

afterEach(() => vi.unstubAllGlobals());

describe("RestClient", () => {
  it("uses the REST endpoints and API payloads for every sync operation", async () => {
    const calls: RequestCall[] = [];
    const responses: unknown[] = [
      [{ slug: "intro", title: "Intro", section: "Guides", nav: "guides", status: "STABLE" }],
      { markdown: "# Intro" },
      { slug: "intro" },
      { slug: "intro" },
      { key: "guides", label: "Guides" },
      { slug: "intro", section: "guides" },
      [{ id: 4, title: "1.0.0", markdown: "Released", tags: ["new"], status: "published" }],
      { id: 4 },
      { id: 4 },
      { deleted: 4 },
      { stats: { created: 3, updated: 1, deleted: 2 } },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        calls.push({
          url: String(input),
          method: init?.method ?? "GET",
          body: init?.body as string | undefined,
          authorization: headers.get("Authorization"),
        });
        return new Response(JSON.stringify(responses.shift()), { status: 200 });
      }),
    );

    const client = new RestClient("https://contextowl.test/api/v1", "cowl_pat_test");
    await expect(client.listArticles(undefined)).resolves.toEqual([
      {
        slug: "intro",
        title: "Intro",
        section: "Guides",
        nav: "guides",
        status: "STABLE",
        encrypted: false,
      },
    ]);
    await expect(client.getArticleMarkdown(undefined, "intro")).resolves.toBe("# Intro");
    await expect(
      client.createArticle(undefined, { title: "Intro", section: "Guides", markdown: "# Intro" }),
    ).resolves.toBe("intro");
    await client.updateArticle(undefined, { slug: "intro", markdown: "Updated", status: "STABLE" });
    await expect(client.createSection(undefined, "Guides")).resolves.toBe("guides");
    await client.placeArticle(undefined, "intro", "guides");
    await expect(client.listChangelog(undefined, true)).resolves.toMatchObject([
      { id: 4, title: "1.0.0" },
    ]);
    await expect(
      client.createChangelog(undefined, {
        title: "1.0.0",
        markdown: "Released",
        status: "published",
      }),
    ).resolves.toBe(4);
    await client.updateChangelog(undefined, { id: 4, markdown: "Updated" });
    await client.deleteChangelog(undefined, 4);
    await expect(client.attachOpenapi(undefined, "openapi: 3.0.0")).resolves.toEqual({
      created: 3,
      updated: 1,
      deleted: 2,
    });

    expect(calls.map(({ url, method, body }) => ({ url, method, body }))).toEqual([
      {
        url: "https://contextowl.test/api/v1/workspaces/-/articles",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://contextowl.test/api/v1/workspaces/-/articles/intro",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://contextowl.test/api/v1/workspaces/-/articles",
        method: "POST",
        body: '{"title":"Intro","section":"Guides","markdown":"# Intro"}',
      },
      {
        url: "https://contextowl.test/api/v1/workspaces/-/articles/intro",
        method: "PATCH",
        body: '{"markdown":"Updated","status":"STABLE"}',
      },
      {
        url: "https://contextowl.test/api/v1/workspaces/-/sections",
        method: "POST",
        body: '{"label":"Guides"}',
      },
      {
        url: "https://contextowl.test/api/v1/workspaces/-/articles/intro/placement",
        method: "POST",
        body: '{"section":"guides"}',
      },
      {
        url: "https://contextowl.test/api/v1/workspaces/-/changelog?drafts=true",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://contextowl.test/api/v1/workspaces/-/changelog",
        method: "POST",
        body: '{"title":"1.0.0","markdown":"Released","status":"published"}',
      },
      {
        url: "https://contextowl.test/api/v1/workspaces/-/changelog/4",
        method: "PATCH",
        body: '{"markdown":"Updated"}',
      },
      {
        url: "https://contextowl.test/api/v1/workspaces/-/changelog/4",
        method: "DELETE",
        body: undefined,
      },
      {
        url: "https://contextowl.test/api/v1/workspaces/-/openapi",
        method: "PUT",
        body: '{"spec":"openapi: 3.0.0"}',
      },
    ]);
    expect(calls.every((call) => call.authorization === "Bearer cowl_pat_test")).toBe(true);
  });

  it("exposes REST permission denials for graceful sync fallbacks", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                code: "permission_denied",
                message: "article.publish is required to change status",
                status: 403,
              },
            }),
            { status: 403, statusText: "Forbidden" },
          ),
      ),
    );

    await expect(
      new RestClient("https://contextowl.test/api/v1", "cowl_pat_test").updateArticle(undefined, {
        slug: "intro",
        status: "STABLE",
      }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof CowlAPIError && err.isPermissionDenied("article.publish"),
    );
  });
});
