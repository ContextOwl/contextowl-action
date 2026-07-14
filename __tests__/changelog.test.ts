import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncChangelog } from "../src/sync/changelog.js";
import { nullLogger } from "../src/logger.js";
import { FakeCowl } from "./fake-cowl.js";

function writeChangelog(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cowl-cl-"));
  const p = join(dir, "CHANGELOG.md");
  writeFileSync(p, body);
  return p;
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

  it("falls back to draft when the token cannot publish", async () => {
    const cowl = new FakeCowl();
    cowl.perms.changelogPublish = false;
    const file = writeChangelog("## [1.0.0] - 2024-01-01\nfirst\n");
    const r = await syncChangelog(cowl, nullLogger, opts(file));

    expect(r.created).toBe(1);
    expect(cowl.changelog[0].status).toBe("draft");
    expect(r.warnings.join(" ")).toMatch(/changelog\.publish/);
  });
});
