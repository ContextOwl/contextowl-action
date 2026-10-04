import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncChangelog } from "../src/sync/changelog.js";
import { nullLogger } from "../src/logger.js";
import { CANONICAL_TAGS, FakeCowl, apiError } from "./fake-cowl.js";

function writeChangelog(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cowl-cl-"));
  const p = join(dir, "CHANGELOG.md");
  writeFileSync(p, body);
  return p;
}

/** A Keep a Changelog file with `count` versions, newest first. */
function keepAChangelog(count: number): string {
  const lines = ["# Changelog", "", "## [Unreleased]", "- next", ""];
  for (let i = count; i >= 1; i--) {
    const date = new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
    lines.push(`## [1.${i}.0] - ${date}`, "### Added", `- Feature ${i}`, "### Changed");
    lines.push(`- Change ${i}`, "");
  }
  return lines.join("\n");
}

const ISO = new Date("2024-01-01").toISOString();
const opts = (file: string, over = {}) => ({
  file,
  workspace: undefined,
  prune: false,
  dryRun: false,
  ...over,
});

describe("syncChangelog", () => {
  it("creates and publishes a new entry", async () => {
    const cowl = new FakeCowl();
    const file = writeChangelog("## [1.0.0] - 2024-01-01\nfirst release\n");
    const r = await syncChangelog(cowl, nullLogger, opts(file));

    expect(r.created).toBe(1);
    expect(cowl.changelog[0].title).toBe("1.0.0");
    expect(cowl.changelog[0].status).toBe("published");
  });

  it("skips an unchanged entry", async () => {
    const cowl = new FakeCowl();
    cowl.seedChangelog({ title: "1.0.0", markdown: "first release", publishedAt: ISO });
    const file = writeChangelog("## [1.0.0] - 2024-01-01\nfirst release\n");
    const r = await syncChangelog(cowl, nullLogger, opts(file));

    expect(r.skipped).toBe(1);
    expect(r.created + r.updated).toBe(0);
  });

  it("updates a changed body", async () => {
    const cowl = new FakeCowl();
    cowl.seedChangelog({ title: "1.0.0", markdown: "old", publishedAt: ISO });
    const file = writeChangelog("## [1.0.0] - 2024-01-01\nnew body\n");
    const r = await syncChangelog(cowl, nullLogger, opts(file));

    expect(r.updated).toBe(1);
    expect(cowl.changelog[0].markdown).toBe("new body");
  });

  it("syncs a file with 60 versions once and never duplicates it", async () => {
    const cowl = new FakeCowl();
    const file = writeChangelog(keepAChangelog(60));

    const first = await syncChangelog(cowl, nullLogger, opts(file));
    expect(first.created).toBe(60);
    expect(first.failed).toBe(0);
    expect(cowl.changelog).toHaveLength(60);
    expect(cowl.changelog.every((e) => e.tags.join() === "new,improved")).toBe(true);
    expect(cowl.sentTags.flat().every((t) => CANONICAL_TAGS.includes(t))).toBe(true);

    cowl.changelogListCalls = [];
    const second = await syncChangelog(cowl, nullLogger, opts(file));
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(60);
    expect(cowl.changelog).toHaveLength(60);
    expect(cowl.changelogListCalls).toEqual([{ drafts: true, limit: 100, offset: 0 }]);
  });

  it("pages with limit and offset until a short page", async () => {
    const cowl = new FakeCowl();
    const file = writeChangelog(keepAChangelog(230));
    await syncChangelog(cowl, nullLogger, opts(file));

    cowl.changelogListCalls = [];
    const r = await syncChangelog(cowl, nullLogger, opts(file));
    expect(r.created).toBe(0);
    expect(r.skipped).toBe(230);
    expect(cowl.changelog).toHaveLength(230);
    expect(cowl.changelogListCalls.map((q) => [q.limit, q.offset])).toEqual([
      [100, 0],
      [100, 100],
      [100, 200],
    ]);
  });

  it("stops before any write when the server repeats a page", async () => {
    const cowl = new FakeCowl();
    for (let i = 0; i < 150; i++) cowl.seedChangelog({ title: `0.${i}.0`, markdown: "x" });
    cowl.ignoreOffset = true;
    const file = writeChangelog("## [9.0.0]\nnew\n");

    await expect(syncChangelog(cowl, nullLogger, opts(file))).rejects.toThrow(/offset paging/);
    expect(cowl.log).toEqual([]);
  });

  it("sends tags that a server before the contract accepts", async () => {
    const cowl = new FakeCowl({ legacy: true });
    const file = writeChangelog(
      "## [2.0.0] - 2024-02-01\n### Added\n- a\n### Changed\n- b\n### Removed\n- c\n### Fixed\n- d\n### Security\n- e\n",
    );
    const r = await syncChangelog(cowl, nullLogger, opts(file));

    expect(r.failed).toBe(0);
    expect(r.created).toBe(1);
    expect(cowl.changelog[0].tags).toEqual(["new", "improved", "deprecated", "fixed", "security"]);
  });

  it("updates the tags of an existing entry with mapped names", async () => {
    const cowl = new FakeCowl({ legacy: true });
    cowl.seedChangelog({ title: "1.0.0", markdown: "### Added\n- a", publishedAt: ISO });
    const file = writeChangelog("## [1.0.0] - 2024-01-01\n### Added\n- a\n");
    const r = await syncChangelog(cowl, nullLogger, opts(file));

    expect(r.updated).toBe(1);
    expect(cowl.sentTags).toEqual([["new"]]);
    expect(cowl.changelog[0].tags).toEqual(["new"]);
  });

  it("drops an unknown subsection name with one warning and still syncs the entry", async () => {
    const cowl = new FakeCowl();
    const file = writeChangelog(
      "## [1.1.0]\n### Added\n- a\n### Notes\n- n\n## [1.0.0]\n### notes\n- n\n",
    );
    const r = await syncChangelog(cowl, nullLogger, opts(file));

    expect(r.created).toBe(2);
    expect(r.failed).toBe(0);
    expect(r.warnings.filter((w) => /### Notes/.test(w))).toHaveLength(1);
    expect(r.warnings.join(" ")).toMatch(/1\.1\.0, 1\.0\.0/);
    expect(cowl.changelog.find((e) => e.title === "1.1.0")?.tags).toEqual(["new"]);
    expect(cowl.changelog.find((e) => e.title === "1.0.0")?.tags).toEqual([]);
  });

  it("syncs only the first of two entries with the same version", async () => {
    const cowl = new FakeCowl();
    const file = writeChangelog("## [1.0.0]\nnewest\n## [1.0.0]\nolder\n");
    const r = await syncChangelog(cowl, nullLogger, opts(file));

    expect(r.created).toBe(1);
    expect(cowl.changelog.map((e) => e.markdown)).toEqual(["newest"]);
    expect(r.warnings.join(" ")).toMatch(/more than once/);
  });

  it("matches published entries only when the key cannot list drafts", async () => {
    const cowl = new FakeCowl();
    cowl.perms.changelogUpdate = false;
    cowl.seedChangelog({ title: "1.0.0", markdown: "first", publishedAt: ISO });
    const file = writeChangelog("## [1.1.0]\nsecond\n## [1.0.0] - 2024-01-01\nfirst\n");
    const r = await syncChangelog(cowl, nullLogger, opts(file));

    expect(cowl.changelogListCalls.map((q) => q.drafts)).toEqual([true, false]);
    expect(r.warnings.join(" ")).toMatch(/changelog\.update/);
    expect([r.created, r.skipped, r.failed]).toEqual([1, 1, 0]);
  });

  it("counts a failed entry and continues with the next one", async () => {
    const cowl = new FakeCowl();
    cowl.failNext(
      "createChangelog",
      apiError("create changelog", 500, { code: "internal", message: "boom" }),
    );
    const file = writeChangelog("## [2.0.0]\nsecond\n## [1.0.0]\nfirst\n");
    const r = await syncChangelog(cowl, nullLogger, opts(file));

    expect(r.created).toBe(1);
    expect(r.failed).toBe(1);
    expect(r.failures).toEqual(['entry "2.0.0" failed: 500 internal: boom']);
    expect(r.warnings).toEqual([]);
  });

  it("deletes orphan entries only when prune is on", async () => {
    const file = writeChangelog("## [1.0.0] - 2024-01-01\nfirst\n");

    const off = new FakeCowl();
    off.seedChangelog({ title: "1.0.0", markdown: "first", publishedAt: ISO });
    off.seedChangelog({ title: "0.9.0", markdown: "beta" });
    await syncChangelog(off, nullLogger, opts(file, { prune: false }));
    expect(off.changelog).toHaveLength(2);

    const on = new FakeCowl();
    on.seedChangelog({ title: "1.0.0", markdown: "first", publishedAt: ISO });
    on.seedChangelog({ title: "0.9.0", markdown: "beta" });
    const r = await syncChangelog(on, nullLogger, opts(file, { prune: true }));
    expect(r.deleted).toBe(1);
    expect(on.changelog.map((e) => e.title)).toEqual(["1.0.0"]);
  });

  it("skips prune with a warning when the key cannot delete, on every server", async () => {
    for (const legacy of [false, true]) {
      const cowl = new FakeCowl({ legacy });
      cowl.perms.changelogDelete = false;
      cowl.seedChangelog({ title: "0.9.0", markdown: "beta" });
      cowl.seedChangelog({ title: "0.8.0", markdown: "alpha" });
      const file = writeChangelog("## [1.0.0]\nfirst\n");
      const r = await syncChangelog(cowl, nullLogger, opts(file, { prune: true }));

      expect(r.failed).toBe(0);
      expect(r.warnings.join(" ")).toMatch(/changelog\.delete/);
      expect(cowl.log.filter((l) => l.startsWith("delete"))).toHaveLength(1);
      expect(cowl.changelog).toHaveLength(3);
    }
  });

  it("counts a failed delete and continues with prune", async () => {
    const cowl = new FakeCowl();
    cowl.seedChangelog({ title: "0.9.0", markdown: "beta" });
    cowl.seedChangelog({ title: "0.8.0", markdown: "alpha" });
    cowl.failNext(
      "deleteChangelog",
      apiError("delete changelog", 500, { code: "internal", message: "boom" }),
    );
    const file = writeChangelog("## [1.0.0]\nfirst\n");
    const r = await syncChangelog(cowl, nullLogger, opts(file, { prune: true }));

    expect(r.deleted).toBe(1);
    expect(r.failed).toBe(1);
    expect(r.failures[0]).toMatch(/^delete ".*" failed: 500 internal: boom$/);
  });

  it("falls back to draft when the token cannot publish, on every server", async () => {
    for (const legacy of [false, true]) {
      const cowl = new FakeCowl({ legacy });
      cowl.perms.changelogPublish = false;
      const file = writeChangelog("## [1.0.0] - 2024-01-01\nfirst\n");
      const r = await syncChangelog(cowl, nullLogger, opts(file));

      expect(r.created).toBe(1);
      expect(r.failed).toBe(0);
      expect(cowl.changelog[0].status).toBe("draft");
      expect(r.warnings.join(" ")).toMatch(/changelog\.publish/);
    }
  });
});
