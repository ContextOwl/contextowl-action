import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { syncDocs } from "../src/sync/docs.js";
import { nullLogger } from "../src/logger.js";
import { FakeCowl, apiError } from "./fake-cowl.js";

function writeTree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "cowl-docs-"));
  for (const [rel, body] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  return dir;
}

const opts = (dir: string, over = {}) => ({
  dir,
  workspace: undefined,
  prune: false,
  dryRun: false,
  allowShrink: false,
  ...over,
});

const boom = (operation: string) => apiError(operation, 500, { code: "internal", message: "boom" });

describe("syncDocs", () => {
  it("creates, places, and publishes a new article", async () => {
    const cowl = new FakeCowl();
    const dir = writeTree({ "guides/intro.md": "---\ntitle: Intro\nstatus: STABLE\n---\nhello" });
    const r = await syncDocs(cowl, nullLogger, opts(dir));

    expect(r.created).toBe(1);
    const a = cowl.articles.get("intro")!;
    expect(a.section).toBe("Guides");
    expect(a.nav).toBe("guides");
    expect(a.status).toBe("STABLE");
    expect(a.markdown).toBe("hello");
  });

  it("uses an explicit slug when creating an article", async () => {
    const cowl = new FakeCowl();
    const dir = writeTree({
      "guides/cli.md": "---\ntitle: cowl - the ContextOwl CLI\nslug: cli\n---\nhello",
    });
    await syncDocs(cowl, nullLogger, opts(dir));

    expect(cowl.articles.get("cli")?.title).toBe("cowl - the ContextOwl CLI");
  });

  it("skips an unchanged article", async () => {
    const cowl = new FakeCowl();
    cowl.seedArticle({ title: "Intro", section: "Guides", status: "STABLE", markdown: "hello" });
    const dir = writeTree({ "guides/intro.md": "---\ntitle: Intro\nstatus: STABLE\n---\nhello" });
    const r = await syncDocs(cowl, nullLogger, opts(dir));

    expect(r.skipped).toBe(1);
    expect(r.created + r.updated).toBe(0);
    expect(cowl.log).toEqual([]);
  });

  it("updates a changed body", async () => {
    const cowl = new FakeCowl();
    cowl.seedArticle({ title: "Intro", section: "Guides", status: "STABLE", markdown: "hello" });
    const dir = writeTree({
      "guides/intro.md": "---\ntitle: Intro\nstatus: STABLE\n---\nhello world",
    });
    const r = await syncDocs(cowl, nullLogger, opts(dir));

    expect(r.updated).toBe(1);
    expect(cowl.articles.get("intro")!.markdown).toBe("hello world");
  });

  it("sends section_key on create when the section exists", async () => {
    const cowl = new FakeCowl();
    cowl.seedArticle({ title: "Old", section: "Guides", markdown: "old" });
    const dir = writeTree({ "guides/intro.md": "---\ntitle: Intro\n---\nhello" });
    const r = await syncDocs(cowl, nullLogger, opts(dir));

    expect(r.created).toBe(1);
    expect(cowl.log).toEqual(["create Intro section_key=guides"]);
    expect(cowl.articles.get("intro")!.nav).toBe("guides");
  });

  it("sends section_key for an existing section that has no articles", async () => {
    const cowl = new FakeCowl();
    cowl.sections.set("reference", "Reference");
    const dir = writeTree({ "reference/api.md": "---\ntitle: API\n---\nhello" });
    const r = await syncDocs(cowl, nullLogger, opts(dir));

    expect([r.created, r.failed]).toEqual([1, 0]);
    expect(cowl.log).toEqual(["create API section_key=reference"]);
    expect(cowl.createSectionCalls).toEqual([]);
    expect(cowl.sections.size).toBe(1);
  });

  it("ignores unplaced articles when it maps section labels to keys, on every server", async () => {
    for (const legacy of [false, true]) {
      const cowl = new FakeCowl({ legacy });
      cowl.seedArticle({ title: "Draft", section: "Guides", nav: "none", markdown: "wip" });
      const dir = writeTree({ "guides/intro.md": "---\ntitle: Intro\n---\nhello" });
      const r = await syncDocs(cowl, nullLogger, opts(dir));

      expect(r.created).toBe(1);
      expect(cowl.createArticleCalls[0].sectionKey).toBeUndefined();
      expect(cowl.log).toEqual(["create Intro", "section Guides", "place intro guides"]);
      expect(cowl.articles.get("intro")!.nav).toBe("guides");
    }
  });

  it("places the first article of a new section, then uses section_key", async () => {
    const cowl = new FakeCowl();
    const dir = writeTree({ "tutorials/a.md": "first", "tutorials/b.md": "second" });
    await syncDocs(cowl, nullLogger, opts(dir));

    expect(cowl.log).toEqual([
      "create A",
      "section Tutorials",
      "place a tutorials",
      "create B section_key=tutorials",
    ]);
    expect(cowl.articles.get("b")!.nav).toBe("tutorials");
  });

  it("places new articles in a second request when the server rejects section_key", async () => {
    const cowl = new FakeCowl({ legacy: true });
    cowl.seedArticle({ title: "Old", section: "Guides", markdown: "old" });
    const dir = writeTree({ "guides/a.md": "first", "guides/b.md": "second" });
    const r = await syncDocs(cowl, nullLogger, opts(dir));

    expect([r.created, r.failed]).toEqual([2, 0]);
    expect(cowl.log).toEqual([
      "create A section_key=guides",
      "create A",
      "place a guides",
      "create B",
      "place b guides",
    ]);
    expect(cowl.articles.get("a")!.nav).toBe("guides");
    expect(cowl.articles.get("b")!.nav).toBe("guides");
  });

  it("places an unplaced article before it publishes it", async () => {
    const cowl = new FakeCowl();
    cowl.seedArticle({ title: "Other", section: "Reference", markdown: "other" });
    cowl.seedArticle({
      title: "Setup",
      section: "Guides",
      nav: "none",
      status: "DRAFT",
      markdown: "steps",
    });
    const dir = writeTree({ "guides/setup.md": "---\ntitle: Setup\nstatus: STABLE\n---\nsteps" });
    const r = await syncDocs(cowl, nullLogger, opts(dir));

    expect(r.updated).toBe(1);
    expect(cowl.log).toEqual([
      "section Guides",
      "place setup guides",
      "update setup status=STABLE",
    ]);
    expect(cowl.articles.get("setup")).toMatchObject({ nav: "guides", status: "STABLE" });
  });

  it("lists a needed placement in the dry-run plan", async () => {
    const cowl = new FakeCowl();
    cowl.seedArticle({ title: "Setup", section: "Guides", nav: "none", markdown: "steps" });
    const dir = writeTree({ "guides/setup.md": "steps" });
    const r = await syncDocs(cowl, nullLogger, opts(dir, { dryRun: true }));

    expect(r.lines).toEqual(['update "Setup" (placement)']);
    expect(cowl.log).toEqual([]);
  });

  it("deprecates orphans only when prune is on", async () => {
    const dir = writeTree({ "guides/intro.md": "---\ntitle: Intro\n---\nhello" });

    const off = new FakeCowl();
    off.seedArticle({ title: "Intro", markdown: "hello" });
    off.seedArticle({ title: "Old", markdown: "gone" });
    const r1 = await syncDocs(off, nullLogger, opts(dir, { prune: false }));
    expect(r1.deleted).toBe(0);
    expect(off.articles.get("old")!.status).toBe("STABLE");

    const on = new FakeCowl();
    on.seedArticle({ title: "Intro", markdown: "hello" });
    on.seedArticle({ title: "Old", markdown: "gone" });
    const r2 = await syncDocs(on, nullLogger, opts(dir, { prune: true }));
    expect(r2.deleted).toBe(1);
    expect(on.articles.get("old")!.status).toBe("DEPRECATED");
  });

  it("counts a failed deprecation and continues with prune", async () => {
    const cowl = new FakeCowl();
    cowl.seedArticle({ title: "Intro", markdown: "hello" });
    cowl.seedArticle({ title: "Old", markdown: "gone" });
    cowl.seedArticle({ title: "Older", markdown: "gone" });
    cowl.failNext("updateArticle", boom("update article"));
    const dir = writeTree({ "intro.md": "---\ntitle: Intro\nsection: Guides\n---\nhello" });
    const r = await syncDocs(cowl, nullLogger, opts(dir, { prune: true }));

    expect(r.deleted).toBe(1);
    expect(r.failures).toEqual(['deprecate "Old" failed: 500 internal: boom']);
    expect(cowl.articles.get("older")!.status).toBe("DEPRECATED");
  });

  it("warns and leaves status when the token cannot publish, on every server", async () => {
    for (const legacy of [false, true]) {
      const cowl = new FakeCowl({ legacy });
      cowl.perms.articlePublish = false;
      const dir = writeTree({ "guides/intro.md": "---\ntitle: Intro\nstatus: STABLE\n---\nhi" });
      const r = await syncDocs(cowl, nullLogger, opts(dir));

      expect(r.created).toBe(1);
      expect(r.failed).toBe(0);
      expect(cowl.articles.get("intro")!.status).toBe("DRAFT");
      expect(r.warnings.join(" ")).toMatch(/article\.publish/);
    }
  });

  it("never modifies or prunes encrypted articles", async () => {
    const cowl = new FakeCowl();
    cowl.seedArticle({ title: "Secret", markdown: "cipher", encrypted: true, status: "STABLE" });
    const dir = writeTree({ "guides/intro.md": "---\ntitle: Intro\n---\nhello" });
    await syncDocs(cowl, nullLogger, opts(dir, { prune: true }));

    const secret = [...cowl.articles.values()].find((a) => a.title === "Secret")!;
    expect(secret.status).toBe("STABLE");
  });

  it("skips OpenAPI-generated pages without a request and keeps them out of prune", async () => {
    const cowl = new FakeCowl();
    cowl.seedArticle({ title: "Users", markdown: "generated", source: "openapi" });
    cowl.seedArticle({ title: "Pets", markdown: "generated", source: "openapi" });
    const dir = writeTree({ "guides/users.md": "---\ntitle: Users\n---\nmine" });
    const r = await syncDocs(cowl, nullLogger, opts(dir, { prune: true }));

    expect(r.warnings).toEqual(['skipped OpenAPI-generated page "Users"']);
    expect([r.updated, r.deleted, r.failed]).toEqual([0, 0, 0]);
    expect(cowl.log).toEqual([]);
    expect(cowl.articles.get("pets")!.status).toBe("STABLE");
  });

  it("skips OpenAPI-generated pages when the server does not report source", async () => {
    const cowl = new FakeCowl({ legacy: true });
    cowl.seedArticle({ title: "Intro", markdown: "old", source: "openapi", status: "STABLE" });
    const dir = writeTree({ "guides/intro.md": "---\ntitle: Intro\n---\nnew" });
    const r = await syncDocs(cowl, nullLogger, opts(dir));

    expect(r.warnings.join(" ")).toMatch(/OpenAPI/);
    expect(r.failed).toBe(0);
    expect(cowl.articles.get("intro")!.markdown).toBe("old");
  });

  it("counts a large removal as a failed item and keeps the body without allow-shrink", async () => {
    const cowl = new FakeCowl();
    cowl.seedArticle({ title: "Big", status: "BETA", markdown: "x".repeat(5000) });
    const dir = writeTree({ "guides/big.md": "---\ntitle: Big\nstatus: STABLE\n---\nshort" });
    const r = await syncDocs(cowl, nullLogger, opts(dir));

    expect([r.updated, r.failed]).toEqual([0, 1]);
    expect(r.failures).toEqual([
      'update "Big" failed: 422 large_removal: the new body removes 4995 of 5000 characters. To accept it, set the allow-shrink input to true',
    ]);
    expect(cowl.log).toEqual(["update big markdown"]);
    expect(cowl.articles.get("big")).toMatchObject({ markdown: "x".repeat(5000), status: "BETA" });
  });

  it("sends a large removal again with allow_shrink when allow-shrink is true", async () => {
    const cowl = new FakeCowl();
    cowl.seedArticle({ title: "Big", markdown: "x".repeat(5000) });
    const dir = writeTree({ "guides/big.md": "---\ntitle: Big\n---\nshort" });
    const r = await syncDocs(cowl, nullLogger, opts(dir, { allowShrink: true }));

    expect([r.updated, r.failed]).toEqual([1, 0]);
    expect(cowl.log).toEqual(["update big markdown", "update big markdown allow_shrink"]);
    expect(cowl.articles.get("big")!.markdown).toBe("short");
    expect(r.warnings).toEqual([
      '"Big": the new body removes 4995 of 5000 characters. The action sends it with allow_shrink.',
    ]);
  });

  it("counts a failed create and continues with the next file", async () => {
    const cowl = new FakeCowl();
    cowl.failNext("createArticle", boom("create article"));
    const dir = writeTree({ "guides/a.md": "first", "guides/b.md": "second" });
    const r = await syncDocs(cowl, nullLogger, opts(dir));

    expect([r.created, r.failed]).toEqual([1, 1]);
    expect(r.failures).toEqual(['create "A" failed: 500 internal: boom']);
    expect(cowl.articles.get("b")!.nav).toBe("guides");
  });

  it("makes no changes in dry-run", async () => {
    const cowl = new FakeCowl();
    const dir = writeTree({ "guides/intro.md": "---\ntitle: Intro\n---\nhello" });
    const r = await syncDocs(cowl, nullLogger, opts(dir, { dryRun: true }));

    expect(r.created).toBe(1);
    expect(cowl.articles.size).toBe(0);
  });
});
