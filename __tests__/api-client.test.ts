import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { RestClient } from "../src/api/client.js";
import { CowlAPIError, describeError } from "../src/types.js";

interface RequestCall {
  url: string;
  method: string;
  body: string | undefined;
  authorization: string | null;
  userAgent: string | null;
}

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

afterEach(() => vi.unstubAllGlobals());

/** Stub fetch with queued responses and record every request. */
function stubFetch(responses: (() => Response)[]): RequestCall[] {
  const calls: RequestCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body as string | undefined,
        authorization: headers.get("Authorization"),
        userAgent: headers.get("User-Agent"),
      });
      const next = responses.shift();
      if (!next) throw new Error("no response queued");
      return next();
    }),
  );
  return calls;
}

const json =
  (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  () =>
    new Response(JSON.stringify(body), { status, headers });

const errorBody = (status: number, error: Record<string, unknown>, headers = {}) =>
  json({ error: { ...error, status } }, status, headers);

const noSleep = { sleep: vi.fn(async () => {}) };
const client = () => new RestClient("https://contextowl.test/api/v1", "cowl_pat_test", noSleep);

describe("RestClient", () => {
  it("uses the REST endpoints and API payloads for every sync operation", async () => {
    const calls = stubFetch([
      json([
        {
          slug: "intro",
          title: "Intro",
          section: "Guides",
          nav: "guides",
          status: "STABLE",
          source: "openapi",
        },
      ]),
      json([{ key: "guides", label: "Guides", visibility: "public", articleCount: 1 }]),
      json({ markdown: "# Intro" }),
      json({ slug: "intro", status: "DRAFT", nav: "guides" }, 201),
      json({ slug: "intro" }),
      json({ key: "guides", label: "Guides", created: false }),
      json({ slug: "intro", section: "guides" }),
      json([{ id: 4, title: "1.0.0", markdown: "Released", tags: ["new"], status: "published" }]),
      json({ id: 4 }, 201),
      json({ id: 4 }),
      json({ deleted: 4 }),
      json({ stats: { created: 3, updated: 1, deleted: 2 } }),
    ]);

    const c = client();
    await expect(c.listArticles(undefined)).resolves.toEqual([
      {
        slug: "intro",
        title: "Intro",
        section: "Guides",
        nav: "guides",
        status: "STABLE",
        encrypted: false,
        source: "openapi",
      },
    ]);
    await expect(c.listSections(undefined)).resolves.toEqual([{ key: "guides", label: "Guides" }]);
    await expect(c.getArticleMarkdown(undefined, "intro")).resolves.toBe("# Intro");
    await expect(
      c.createArticle(undefined, {
        title: "Intro",
        slug: "introduction",
        section: "Guides",
        sectionKey: "guides",
        markdown: "# Intro",
      }),
    ).resolves.toEqual({ slug: "intro", nav: "guides" });
    await c.updateArticle(undefined, { slug: "intro", markdown: "Updated", status: "STABLE" });
    await expect(c.createSection(undefined, "Guides")).resolves.toBe("guides");
    await c.placeArticle(undefined, "intro", "guides");
    await expect(
      c.listChangelog(undefined, { drafts: true, limit: 100, offset: 200 }),
    ).resolves.toMatchObject([{ id: 4, title: "1.0.0" }]);
    await expect(
      c.createChangelog(undefined, {
        title: "1.0.0",
        markdown: "Released",
        tags: ["new"],
        status: "published",
      }),
    ).resolves.toBe(4);
    await c.updateChangelog(undefined, { id: 4, markdown: "Updated" });
    await c.deleteChangelog(undefined, 4);
    await expect(c.attachOpenapi(undefined, "openapi: 3.0.0")).resolves.toEqual({
      stats: { created: 3, updated: 1, deleted: 2 },
      unchanged: false,
    });

    const base = "https://contextowl.test/api/v1/workspaces/-";
    expect(calls.map(({ url, method, body }) => ({ url, method, body }))).toEqual([
      { url: `${base}/articles`, method: "GET", body: undefined },
      { url: `${base}/sections`, method: "GET", body: undefined },
      { url: `${base}/articles/intro`, method: "GET", body: undefined },
      {
        url: `${base}/articles`,
        method: "POST",
        body: '{"title":"Intro","slug":"introduction","section":"Guides","section_key":"guides","markdown":"# Intro"}',
      },
      {
        url: `${base}/articles/intro`,
        method: "PATCH",
        body: '{"markdown":"Updated","status":"STABLE"}',
      },
      { url: `${base}/sections`, method: "POST", body: '{"label":"Guides"}' },
      { url: `${base}/articles/intro/placement`, method: "POST", body: '{"section":"guides"}' },
      {
        url: `${base}/changelog?drafts=true&limit=100&offset=200`,
        method: "GET",
        body: undefined,
      },
      {
        url: `${base}/changelog`,
        method: "POST",
        body: '{"title":"1.0.0","markdown":"Released","tags":["new"],"status":"published"}',
      },
      { url: `${base}/changelog/4`, method: "PATCH", body: '{"markdown":"Updated"}' },
      { url: `${base}/changelog/4`, method: "DELETE", body: undefined },
      { url: `${base}/openapi`, method: "PUT", body: '{"spec":"openapi: 3.0.0"}' },
    ]);
    expect(calls.every((call) => call.authorization === "Bearer cowl_pat_test")).toBe(true);
    expect(calls.every((call) => call.userAgent === `contextowl-action/${version}`)).toBe(true);
  });

  it("omits section_key and allow_shrink unless they are set", async () => {
    const calls = stubFetch([json({ slug: "intro" }, 201), json({ slug: "intro" }), json([])]);
    const c = client();

    await expect(c.createArticle("docs", { title: "Intro", markdown: "x" })).resolves.toEqual({
      slug: "intro",
      nav: "",
    });
    await c.updateArticle("docs", { slug: "intro", markdown: "y", allowShrink: true });
    await c.listChangelog("docs", { drafts: false });

    expect(calls.map((call) => call.body)).toEqual([
      '{"title":"Intro","markdown":"x"}',
      '{"markdown":"y","allow_shrink":true}',
      undefined,
    ]);
    expect(calls[2].url).toBe("https://contextowl.test/api/v1/workspaces/docs/changelog");
  });

  it("reports an unchanged OpenAPI spec", async () => {
    stubFetch([json({ configured: true, unchanged: true })]);
    await expect(client().attachOpenapi(undefined, "openapi: 3.0.0")).resolves.toEqual({
      stats: null,
      unchanged: true,
    });
  });

  it("reads the code, message, and details of an error response", async () => {
    stubFetch([
      errorBody(403, {
        code: "permission_denied",
        message: "this key lacks the openapi.attach permission",
        details: { permission: "openapi.attach" },
      }),
    ]);

    const err = await client()
      .attachOpenapi(undefined, "openapi: 3.0.0")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CowlAPIError);
    expect(err).toMatchObject({
      status: 403,
      code: "permission_denied",
      details: { permission: "openapi.attach" },
    });
    expect(describeError(err)).toBe(
      "403 permission_denied: this key lacks the openapi.attach permission",
    );
  });

  it("matches a permission by details, or by message on older servers", async () => {
    const named = new CowlAPIError("op", "this key lacks the required permission", 403, "x", {
      permission: "article.publish",
    });
    expect(named.isPermissionDenied("article.publish")).toBe(true);
    expect(named.isPermissionDenied("article.update")).toBe(false);

    const legacy = new CowlAPIError("op", "article.publish is required to change status", 403);
    expect(legacy.isPermissionDenied("article.publish")).toBe(true);

    const unnamed = new CowlAPIError("op", "this key lacks the required permission", 403);
    expect(unnamed.isPermissionDenied("openapi.attach")).toBe(false);
    expect(unnamed.isPermissionDenied()).toBe(true);
    expect(new CowlAPIError("op", "plan", 402).isPermissionDenied()).toBe(false);
  });

  it("uses the status text when the error body is not JSON", async () => {
    stubFetch([
      () => new Response("<html>bad gateway</html>", { status: 500, statusText: "Oops" }),
    ]);
    await expect(client().listArticles(undefined)).rejects.toMatchObject({
      status: 500,
      message: "Oops",
    });
  });

  it("retries a 429 after Retry-After, also for a write", async () => {
    const sleep = vi.fn(async () => {});
    const calls = stubFetch([
      errorBody(429, { code: "rate_limited", message: "slow down" }, { "Retry-After": "2" }),
      json({ id: 7 }, 201),
    ]);
    const c = new RestClient("https://contextowl.test/api/v1", "cowl_pat_test", { sleep });

    await expect(c.createChangelog(undefined, { title: "1.0.0", markdown: "x" })).resolves.toBe(7);
    expect(calls).toHaveLength(2);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("gives up after 4 attempts on 429", async () => {
    const limited = errorBody(429, { code: "rate_limited", message: "slow down" });
    const calls = stubFetch([limited, limited, limited, limited]);

    await expect(client().listArticles(undefined)).rejects.toMatchObject({
      status: 429,
      code: "rate_limited",
    });
    expect(calls).toHaveLength(4);
  });

  it("retries a 503 for a GET only", async () => {
    const unavailable = errorBody(503, { code: "unavailable", message: "try again" });
    const reads = stubFetch([unavailable, json([])]);
    await expect(client().listArticles(undefined)).resolves.toEqual([]);
    expect(reads).toHaveLength(2);

    const writes = stubFetch([unavailable, json({ id: 1 }, 201)]);
    await expect(
      client().createChangelog(undefined, { title: "1.0.0", markdown: "x" }),
    ).rejects.toMatchObject({ status: 503 });
    expect(writes).toHaveLength(1);
  });

  it("reports a network failure without a status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const err = await client()
      .listArticles(undefined)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CowlAPIError);
    expect(describeError(err)).toBe("request failed: fetch failed");
  });
});
