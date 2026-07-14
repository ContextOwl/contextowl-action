import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { syncDocs } from "../src/sync/docs.js";
import { nullLogger } from "../src/logger.js";
import { FakeCowl } from "./fake-cowl.js";

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
  ...over,
});

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

  it("skips an unchanged article", async () => {
    const cowl = new FakeCowl();
    cowl.seedArticle({ title: "Intro", section: "Guides", status: "STABLE", markdown: "hello" });
    const dir = writeTree({ "guides/intro.md": "---\ntitle: Intro\nstatus: STABLE\n---\nhello" });
    const r = await syncDocs(cowl, nullLogger, opts(dir));

    expect(r.skipped).toBe(1);
    expect(r.created + r.updated).toBe(0);
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

  it("warns and leaves status when the token cannot publish", async () => {
    const cowl = new FakeCowl();
    cowl.perms.articlePublish = false;
    const dir = writeTree({ "guides/intro.md": "---\ntitle: Intro\nstatus: STABLE\n---\nhi" });
    const r = await syncDocs(cowl, nullLogger, opts(dir));

    expect(r.created).toBe(1);
    expect(cowl.articles.get("intro")!.status).toBe("DRAFT");
    expect(r.warnings.join(" ")).toMatch(/article\.publish/);
  });

  it("never modifies or prunes encrypted articles", async () => {
    const cowl = new FakeCowl();
    cowl.seedArticle({ title: "Secret", markdown: "cipher", encrypted: true, status: "STABLE" });
    const dir = writeTree({ "guides/intro.md": "---\ntitle: Intro\n---\nhello" });
    await syncDocs(cowl, nullLogger, opts(dir, { prune: true }));

    const secret = [...cowl.articles.values()].find((a) => a.title === "Secret")!;
    expect(secret.status).toBe("STABLE");
  });

  it("skips OpenAPI-generated pages on update", async () => {
    const cowl = new FakeCowl();
    cowl.seedArticle({ title: "Intro", markdown: "old", openapi: true, status: "STABLE" });
    const dir = writeTree({ "guides/intro.md": "---\ntitle: Intro\n---\nnew" });
    const r = await syncDocs(cowl, nullLogger, opts(dir));

    expect(r.warnings.join(" ")).toMatch(/OpenAPI/);
    expect(cowl.articles.get("intro")!.markdown).toBe("old");
  });

  it("makes no changes in dry-run", async () => {
    const cowl = new FakeCowl();
    const dir = writeTree({ "guides/intro.md": "---\ntitle: Intro\n---\nhello" });
    const r = await syncDocs(cowl, nullLogger, opts(dir, { dryRun: true }));

    expect(r.created).toBe(1);
    expect(cowl.articles.size).toBe(0);
  });
});
