import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { syncDocs } from "../src/sync/docs.js";
import { jobFailure } from "../src/sync/plan.js";
import { nullLogger } from "../src/logger.js";
import { FakeCowl, apiError, upgradeRequired } from "./fake-cowl.js";

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

/** The 402 for a section that is not public, on a plan without private content. */
const privateSection = (operation: string) =>
  apiError(operation, 402, {
    code: "upgrade_required",
    message: "internal and private content needs a paid plan or an active trial",
    details: { feature: "private_content" },
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

  it("syncs articles whose section the key cannot create and warns once, on every server", async () => {
    for (const legacy of [false, true]) {
      const cowl = new FakeCowl({ legacy });
      cowl.perms.sectionCreate = false;
      cowl.seedArticle({ title: "Overview", section: "Quickstart", nav: "none", markdown: "old" });
      cowl.seedArticle({ title: "APIs", section: "Reference", nav: "none", markdown: "old" });
      cowl.seedArticle({ title: "CLI", section: "Platform", markdown: "cli" });
      cowl.seedArticle({ title: "Action", section: "Reference", nav: "none", markdown: "old" });
      cowl.seedArticle({ title: "Setup", section: "Quickstart", nav: "none", markdown: "same" });
      const dir = writeTree({
        "01-overview.md": "---\ntitle: Overview\nsection: Quickstart\n---\nnew",
        "02-apis.md": "---\ntitle: APIs\nsection: Reference\n---\nnew",
        "03-cli.md": "---\ntitle: CLI\nsection: Platform\n---\ncli",
        "04-action.md": "---\ntitle: Action\nsection: Reference\n---\nnew",
        "05-setup.md": "---\ntitle: Setup\nsection: Quickstart\n---\nsame",
      });
      const r = await syncDocs(cowl, nullLogger, opts(dir));

      expect([r.updated, r.skipped, r.failed]).toEqual([3, 2, 0]);
      expect(jobFailure([r], true)).toBeUndefined();
      expect(cowl.log).toEqual([
        "update overview markdown",
        "section Quickstart",
        "update apis markdown",
        "update action markdown",
      ]);
      for (const slug of ["overview", "apis", "action", "setup"]) {
        expect(cowl.articles.get(slug)!.nav).toBe("none");
      }
      expect(cowl.articles.get("apis")!.markdown).toBe("new");
      const serverError = legacy
        ? "this key lacks the required permission"
        : "this key lacks the section.create permission";
      expect(r.warnings).toEqual([
        `the key lacks section.create, so the action cannot create the sections "Quickstart" and "Reference". It syncs the articles for these sections but does not place them there. To place them, add section.create to the key or create the sections in the app. Server error: 403 permission_denied: ${serverError}`,
      ]);
    }
  });

  it("keeps the place and label of an article whose new section the key cannot create", async () => {
    const cowl = new FakeCowl();
    cowl.perms.sectionCreate = false;
    cowl.seedArticle({ title: "Setup", section: "Guides", markdown: "old" });
    const dir = writeTree({ "setup.md": "---\ntitle: Setup\nsection: Reference\n---\nnew" });
    const first = await syncDocs(cowl, nullLogger, opts(dir));

    expect([first.updated, first.failed]).toEqual([1, 0]);
    expect(cowl.updateArticleCalls).toEqual([{ slug: "setup", markdown: "new" }]);
    expect(cowl.articles.get("setup")).toMatchObject({
      markdown: "new",
      section: "Guides",
      nav: "guides",
    });
    expect(first.warnings).toHaveLength(1);
    expect(first.warnings[0]).toMatch(/cannot create the section "Reference"\./);

    // Someone creates the section in the app. The next run moves the article.
    cowl.sections.set("reference", "Reference");
    cowl.log = [];
    const second = await syncDocs(cowl, nullLogger, opts(dir));

    expect([second.updated, second.failed]).toEqual([1, 0]);
    expect(second.warnings).toEqual([]);
    expect(cowl.log).toEqual(["place setup reference", "update setup"]);
    expect(cowl.articles.get("setup")).toMatchObject({ section: "Reference", nav: "reference" });
  });

  it("creates a new article without section_key when the key cannot create its section", async () => {
    const cowl = new FakeCowl();
    cowl.perms.sectionCreate = false;
    cowl.sections.set("guides", "Guides");
    const dir = writeTree({
      "tutorials/a.md": "first",
      "tutorials/b.md": "---\ntitle: B\nstatus: STABLE\n---\nsecond",
    });
    const r = await syncDocs(cowl, nullLogger, opts(dir));

    expect([r.created, r.failed]).toEqual([2, 0]);
    expect(jobFailure([r], true)).toBeUndefined();
    expect(cowl.createArticleCalls.map((c) => c.sectionKey)).toEqual([undefined, undefined]);
    expect(cowl.log).toEqual([
      "create A",
      "section Tutorials",
      "create B",
      "update b status=STABLE",
    ]);
    expect(cowl.articles.get("a")).toMatchObject({
      nav: "none",
      status: "DRAFT",
      markdown: "first",
    });
    // The action still publishes B, and the server puts it in the first section.
    expect(cowl.articles.get("b")).toMatchObject({ nav: "guides", status: "STABLE" });
    expect(r.lines).toEqual(['created "A"', 'created "B"']);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(
      /section\.create, so the action cannot create the section "Tutorials"/,
    );

    // Someone creates the section in the app. The next run moves both articles.
    cowl.sections.set("tutorials", "Tutorials");
    cowl.log = [];
    const next = await syncDocs(cowl, nullLogger, opts(dir));

    expect([next.updated, next.failed]).toEqual([2, 0]);
    expect(next.warnings).toEqual([]);
    expect(cowl.log).toEqual(["place a tutorials", "place b tutorials", "update b"]);
    expect(cowl.articles.get("a")!.nav).toBe("tutorials");
    expect(cowl.articles.get("b")).toMatchObject({ nav: "tutorials", status: "STABLE" });
  });

  it("treats a 402 answer to createSection like a missing permission", async () => {
    const cowl = new FakeCowl();
    cowl.failNext("createSection", upgradeRequired("create section", "section.create"));
    const dir = writeTree({ "tutorials/a.md": "first" });
    const r = await syncDocs(cowl, nullLogger, opts(dir));

    expect([r.created, r.failed]).toEqual([1, 0]);
    expect(cowl.articles.get("a")!.nav).toBe("none");
    expect(r.warnings).toEqual([
      'your plan does not allow section.create, so the action cannot create the section "Tutorials". It syncs the articles for this section but does not place them there. To place them, create the section in the app or upgrade the plan. Server error: 402 upgrade_required: section.create needs a paid plan or an active trial',
    ]);
  });

  it("fails the article when createSection fails for another reason", async () => {
    const creates = new FakeCowl();
    creates.failNext("createSection", boom("create section"));
    const r1 = await syncDocs(
      creates,
      nullLogger,
      opts(writeTree({ "tutorials/a.md": "first", "tutorials/b.md": "second" })),
    );
    expect([r1.created, r1.failed]).toEqual([1, 1]);
    expect(r1.failures).toEqual(['create "A" failed: 500 internal: boom']);
    expect(r1.warnings).toEqual([]);
    expect(creates.articles.get("b")!.nav).toBe("tutorials");
    expect(jobFailure([r1], true)).toBe("1 item failed to sync. See the job summary.");

    const updates = new FakeCowl();
    updates.seedArticle({ title: "Setup", section: "Reference", nav: "none", markdown: "old" });
    updates.failNext("createSection", boom("create section"));
    const r2 = await syncDocs(
      updates,
      nullLogger,
      opts(writeTree({ "reference/setup.md": "---\ntitle: Setup\n---\nnew" })),
    );
    expect([r2.updated, r2.failed]).toEqual([0, 1]);
    expect(r2.failures).toEqual(['update "Setup" failed: 500 internal: boom']);
    expect(r2.warnings).toEqual([]);
  });

  it("syncs articles that the key cannot move and warns once, on every server", async () => {
    for (const legacy of [false, true]) {
      const cowl = new FakeCowl({ legacy });
      cowl.perms.articlePlace = false;
      cowl.seedArticle({ title: "API", section: "Reference", markdown: "old" });
      cowl.seedArticle({ title: "FAQ", section: "Guides", nav: "none", markdown: "same" });
      cowl.seedArticle({ title: "Intro", section: "Guides", markdown: "hello" });
      cowl.seedArticle({ title: "Setup", section: "Guides", nav: "none", markdown: "old" });
      const dir = writeTree({
        "01-api.md": "---\ntitle: API\nsection: Guides\n---\nnew",
        "02-faq.md": "---\ntitle: FAQ\nsection: Guides\n---\nsame",
        "03-intro.md": "---\ntitle: Intro\nsection: Guides\n---\nhello",
        "04-setup.md": "---\ntitle: Setup\nsection: Guides\n---\nnew",
      });
      const r = await syncDocs(cowl, nullLogger, opts(dir));

      expect([r.updated, r.skipped, r.failed]).toEqual([2, 2, 0]);
      expect(jobFailure([r], true)).toBeUndefined();
      expect(cowl.log).toEqual([
        "update api markdown",
        "place api guides",
        "update setup markdown",
      ]);
      expect(cowl.articles.get("api")).toMatchObject({
        markdown: "new",
        section: "Reference",
        nav: "reference",
      });
      expect(cowl.articles.get("faq")!.nav).toBe("none");
      expect(cowl.articles.get("setup")).toMatchObject({ markdown: "new", nav: "none" });
      const serverError = legacy
        ? "this key lacks the required permission"
        : "this key lacks the article.place permission";
      expect(r.warnings).toEqual([
        `the key lacks article.place, so the action cannot move the articles "API", "FAQ" and "Setup" into their sections. It syncs the content and keeps the current placement. To move the articles, add article.place to the key or move them in the app. Server error: 403 permission_denied: ${serverError}`,
      ]);
    }
  });

  it("creates new articles that the key cannot move and moves them once it can", async () => {
    const cowl = new FakeCowl();
    cowl.perms.articlePlace = false;
    cowl.sections.set("guides", "Guides");
    const dir = writeTree({
      "guides/a.md": "first",
      "tutorials/b.md": "second",
      "tutorials/c.md": "third",
    });
    const r = await syncDocs(cowl, nullLogger, opts(dir));

    expect([r.created, r.failed]).toEqual([3, 0]);
    expect(jobFailure([r], true)).toBeUndefined();
    // A create with section_key places the article without article.place.
    expect(cowl.log).toEqual([
      "create A section_key=guides",
      "create B",
      "section Tutorials",
      "place b tutorials",
      "create C section_key=tutorials",
    ]);
    expect(cowl.articles.get("a")!.nav).toBe("guides");
    expect(cowl.articles.get("b")!.nav).toBe("none");
    expect(cowl.articles.get("c")!.nav).toBe("tutorials");
    expect(r.lines).toEqual(['created "A" in Guides', 'created "B"', 'created "C" in Tutorials']);
    expect(r.warnings).toEqual([
      'the key lacks article.place, so the action cannot move the article "B" into its section. It syncs the content and keeps the current placement. To move the article, add article.place to the key or move it in the app. Server error: 403 permission_denied: this key lacks the article.place permission',
    ]);

    // The key gets article.place. The next run moves the article.
    cowl.perms.articlePlace = true;
    cowl.log = [];
    const next = await syncDocs(cowl, nullLogger, opts(dir));

    expect([next.updated, next.skipped, next.failed]).toEqual([1, 2, 0]);
    expect(next.warnings).toEqual([]);
    expect(cowl.log).toEqual(["place b tutorials"]);
    expect(cowl.articles.get("b")!.nav).toBe("tutorials");
  });

  it("keeps moving other articles after a 402 for a section that is not public", async () => {
    const cowl = new FakeCowl();
    cowl.sections.set("internal", "Internal");
    cowl.sections.set("guides", "Guides");
    cowl.seedArticle({ title: "Ops", section: "Internal", nav: "none", markdown: "old" });
    cowl.seedArticle({ title: "Setup", section: "Guides", nav: "none", markdown: "same" });
    cowl.failNext("placeArticle", privateSection("place article"));
    const dir = writeTree({
      "01-ops.md": "---\ntitle: Ops\nsection: Internal\n---\nnew",
      "02-setup.md": "---\ntitle: Setup\nsection: Guides\n---\nsame",
    });
    const r = await syncDocs(cowl, nullLogger, opts(dir));

    expect([r.updated, r.failed]).toEqual([2, 0]);
    expect(cowl.log).toEqual(["update ops markdown", "place ops internal", "place setup guides"]);
    expect(cowl.articles.get("ops")).toMatchObject({ markdown: "new", nav: "none" });
    expect(cowl.articles.get("setup")!.nav).toBe("guides");
    expect(r.warnings).toEqual([
      'your plan does not allow article.place for the article "Ops", so the action cannot move it into its section. It syncs the content and keeps the current placement. To move the article, upgrade the plan. Server error: 402 upgrade_required: internal and private content needs a paid plan or an active trial',
    ]);
  });

  it("creates an article without section_key when the plan refuses its section", async () => {
    const cowl = new FakeCowl();
    cowl.sections.set("internal", "Internal");
    cowl.failNext("createArticle", privateSection("create article"));
    cowl.failNext("placeArticle", privateSection("place article"));
    const dir = writeTree({ "internal/ops.md": "---\ntitle: Ops\n---\nsteps" });
    const r = await syncDocs(cowl, nullLogger, opts(dir));

    expect([r.created, r.failed]).toEqual([1, 0]);
    expect(cowl.log).toEqual([
      "create Ops section_key=internal",
      "create Ops",
      "place ops internal",
    ]);
    expect(cowl.articles.get("ops")).toMatchObject({ markdown: "steps", nav: "none" });
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/^your plan does not allow article\.place for the article "Ops"/);
  });

  it("fails the article when the placement fails for another reason", async () => {
    const creates = new FakeCowl();
    creates.failNext("placeArticle", boom("place article"));
    const r1 = await syncDocs(
      creates,
      nullLogger,
      opts(writeTree({ "tutorials/a.md": "first", "tutorials/b.md": "second" })),
    );
    expect([r1.created, r1.failed]).toEqual([1, 1]);
    expect(r1.failures).toEqual(['create "A" failed: 500 internal: boom']);
    expect(r1.warnings).toEqual([]);
    expect(creates.articles.get("b")!.nav).toBe("tutorials");

    const updates = new FakeCowl();
    updates.sections.set("guides", "Guides");
    updates.seedArticle({ title: "Setup", section: "Guides", nav: "none", markdown: "old" });
    updates.seedArticle({ title: "Usage", section: "Guides", nav: "none", markdown: "same" });
    updates.failNext("placeArticle", boom("place article"));
    const r2 = await syncDocs(
      updates,
      nullLogger,
      opts(
        writeTree({
          "guides/setup.md": "---\ntitle: Setup\n---\nnew",
          "guides/usage.md": "---\ntitle: Usage\n---\nsame",
        }),
      ),
    );
    expect([r2.updated, r2.failed]).toEqual([1, 1]);
    expect(r2.failures).toEqual(['update "Setup" failed: 500 internal: boom']);
    expect(r2.warnings).toEqual([]);
    expect(updates.articles.get("setup")).toMatchObject({ markdown: "new", nav: "none" });
    expect(updates.articles.get("usage")!.nav).toBe("guides");
    expect(jobFailure([r2], true)).toBe("1 item failed to sync. See the job summary.");
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
