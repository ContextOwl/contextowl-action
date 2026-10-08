import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedConfig } from "../src/config.js";
import { type Logger, nullLogger } from "../src/logger.js";
import { PROPOSALS_UNREAD, REVIEW_HINT, runSync } from "../src/sync/index.js";
import {
  type SurfaceResult,
  emptyResult,
  jobFailure,
  proposalHtml,
  proposalLine,
  summaryTable,
  totals,
  totalsLine,
} from "../src/sync/plan.js";
import { FakeCowl, apiError } from "./fake-cowl.js";

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "cowl-run-"));
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "docs", "intro.md"), "hello");
  writeFileSync(join(root, "CHANGELOG.md"), "## [1.0.0]\n### Added\n- first\n");
  writeFileSync(join(root, "openapi.yaml"), "openapi: 3.0.0\n");
  return root;
}

/** A logger that keeps the info lines. */
function infoLogger(lines: string[]): Logger {
  return { ...nullLogger, info: (m) => lines.push(m) };
}

const NOTE =
  "Fix the steps. Commit 1a2b3c4 in acme/docs: https://github.com/acme/docs/commit/1a2b3c4";

const config = (over: Partial<ResolvedConfig> = {}): ResolvedConfig => ({
  apiUrl: "https://contextowl.test/api/v1",
  token: "cowl_pat_test",
  workspace: undefined,
  prune: false,
  dryRun: false,
  failOnError: true,
  allowShrink: false,
  docs: { dir: "docs" },
  changelog: { file: "CHANGELOG.md" },
  ...over,
});

const result = (over: Partial<SurfaceResult>): SurfaceResult => ({
  ...emptyResult("docs"),
  ...over,
});

describe("runSync", () => {
  it("records a surface that stops and still runs the next one", async () => {
    const cowl = new FakeCowl();
    cowl.failNext(
      "listArticles",
      apiError("list articles", 401, { code: "unauthorized", message: "bad key" }),
    );
    const [docs, changelog] = await runSync(cowl, nullLogger, config(), repo());

    expect(docs.stopped).toBe(true);
    expect(docs.failed).toBe(1);
    expect(docs.failures).toEqual(["docs sync stopped: 401 unauthorized: bad key"]);
    expect(changelog.stopped).toBe(false);
    expect(changelog.created).toBe(1);
    expect(totals([docs, changelog])).toMatchObject({ created: 1, failed: 1 });
    expect(jobFailure([docs, changelog], false)).toBe(
      "Sync stopped for docs. See the job summary.",
    );
  });

  it("fails before any request when a configured path is missing", async () => {
    const cowl = new FakeCowl();
    await expect(
      runSync(cowl, nullLogger, config({ docs: { dir: "missing" } }), repo()),
    ).rejects.toThrow(/docs\.dir \(missing\)/);
    expect(cowl.log).toEqual([]);
  });

  it("sends the note to a server that returns writes", async () => {
    for (const writes of ["review", "direct"] as const) {
      const cowl = new FakeCowl();
      cowl.writes = writes;
      cowl.seedArticle({ title: "Intro", markdown: "old" });
      const cfg = config({ openapi: { spec: "openapi.yaml" } });
      const results = await runSync(cowl, nullLogger, cfg, repo(), NOTE);

      expect(totals(results).failed).toBe(0);
      expect(cowl.notes).toEqual([NOTE, NOTE, NOTE]);
      expect(totals(results).proposed).toBe(writes === "review" ? 3 : 0);
    }
  });

  it("sends no note to a server without the review, on every server", async () => {
    for (const legacy of [false, true]) {
      const cowl = new FakeCowl({ legacy });
      cowl.seedArticle({ title: "Intro", markdown: "old" });
      const cfg = config({ openapi: { spec: "openapi.yaml" } });
      const results = await runSync(cowl, nullLogger, cfg, repo(), NOTE);

      // The fake answers 400 invalid_body to a note in a request body.
      expect(totals(results)).toMatchObject({ created: 1, updated: 1, failed: 0, proposed: 0 });
      expect(cowl.notes).toEqual([undefined, undefined, undefined]);
    }
  });

  it("reads the pending proposals once and withdraws a change that the repository reverted", async () => {
    const cowl = new FakeCowl();
    cowl.writes = "review";
    cowl.seedArticle({ title: "Intro", markdown: "old" });
    const root = repo();
    const first = await runSync(cowl, nullLogger, config(), root, NOTE);
    expect(totals(first)).toMatchObject({ skipped: 0, proposed: 2, failed: 0 });

    writeFileSync(join(root, "docs", "intro.md"), "old");
    const second = await runSync(cowl, nullLogger, config(), root, NOTE);

    expect(totals(second)).toMatchObject({ skipped: 1, proposed: 1, failed: 0 });
    expect(cowl.withdrawn.map((p) => p.target)).toEqual(["article:intro"]);
    expect(cowl.listProposalsCalls).toBe(2);
  });

  it("sends no status in the reset write when the key cannot use article.publish", async () => {
    const cowl = new FakeCowl();
    cowl.writes = "review";
    cowl.perms.articlePublish = false;
    cowl.seedArticle({ title: "Intro", markdown: "old" });
    const root = repo();
    await runSync(cowl, nullLogger, config({ changelog: undefined }), root, NOTE);
    expect(cowl.proposals.size).toBe(1);

    writeFileSync(join(root, "docs", "intro.md"), "old");
    const results = await runSync(cowl, nullLogger, config({ changelog: undefined }), root, NOTE);

    expect(totals(results)).toMatchObject({ skipped: 1, proposed: 0, failed: 0 });
    expect(cowl.updateArticleCalls.at(-1)).not.toHaveProperty("status");
    expect(cowl.proposals.size).toBe(0);
  });

  it("warns and still syncs when the server cannot list the proposals", async () => {
    const cowl = new FakeCowl();
    cowl.writes = "review";
    cowl.failNext(
      "listProposals",
      apiError("list proposals", 500, { code: "internal", message: "boom" }),
    );
    const warnings: string[] = [];
    const logger = { ...nullLogger, warning: (m: string) => warnings.push(m) };
    const results = await runSync(cowl, logger, config(), repo(), NOTE);

    expect(warnings).toEqual([`${PROPOSALS_UNREAD} Server error: 500 internal: boom`]);
    expect(totals(results)).toMatchObject({ created: 1, proposed: 1, failed: 0 });
  });

  it("reads no proposals in a dry run, without the review, or without docs and changelog", async () => {
    const runs: [FakeCowl["writes"], Partial<ResolvedConfig>][] = [
      ["review", { dryRun: true }],
      ["direct", {}],
      [undefined, {}],
      ["review", { docs: undefined, changelog: undefined, openapi: { spec: "openapi.yaml" } }],
    ];
    for (const [writes, over] of runs) {
      const cowl = new FakeCowl();
      cowl.writes = writes;
      const results = await runSync(cowl, nullLogger, config(over), repo(), NOTE);

      expect(totals(results).failed).toBe(0);
      expect(cowl.listProposalsCalls).toBe(0);
    }
  });

  it("logs a hint when the changes of the key wait for review", async () => {
    for (const writes of ["review", "direct", undefined] as const) {
      const cowl = new FakeCowl();
      cowl.writes = writes;
      const lines: string[] = [];
      await runSync(cowl, infoLogger(lines), config({ dryRun: true }), repo());

      expect(lines.includes(REVIEW_HINT)).toBe(writes === "review");
      expect(cowl.log).toEqual([]);
    }
  });
});

describe("summaryTable", () => {
  it("shows the Proposed column only when a change waits for review", () => {
    const docs = result({ created: 1, updated: 2, skipped: 3 });
    expect(summaryTable([docs])).toEqual([
      ["Surface", "Created", "Updated", "Removed", "Unchanged", "Failed"],
      ["docs", "1", "2", "0", "3", "0"],
      ["total", "1", "2", "0", "3", "0"],
    ]);

    const changelog = result({ surface: "changelog", proposed: 2, stopped: true, failed: 1 });
    expect(summaryTable([docs, changelog])).toEqual([
      ["Surface", "Created", "Updated", "Proposed", "Removed", "Unchanged", "Failed"],
      ["docs", "1", "2", "0", "0", "3", "0"],
      ["changelog (stopped)", "0", "0", "2", "0", "0", "1"],
      ["total", "1", "2", "2", "0", "3", "1"],
    ]);
  });
});

describe("proposalLine and proposalHtml", () => {
  const review = {
    id: 42,
    objectType: "article",
    summary: "Publish a-b: DRAFT to STABLE",
    outcome: "created",
    reviewUrl: "https://contextowl.test/admin/proposals?ws=docs&id=42",
  };

  it("names the item, the summary, and the review link", () => {
    const proposal = { item: '"A & <B>"', review };
    expect(proposalLine(proposal)).toBe(
      '"A & <B>": Publish a-b: DRAFT to STABLE. Proposal 42 waits for review: https://contextowl.test/admin/proposals?ws=docs&id=42',
    );
    expect(proposalHtml(proposal)).toBe(
      '&quot;A &amp; &lt;B&gt;&quot;: Publish a-b: DRAFT to STABLE. Proposal 42 waits for review: <a href="https://contextowl.test/admin/proposals?ws=docs&amp;id=42">https://contextowl.test/admin/proposals?ws=docs&amp;id=42</a>',
    );
  });

  it("names Admin > Proposals when the answer has no link, and links only web URLs", () => {
    const bare = { id: 0, objectType: "", summary: "", outcome: "", reviewUrl: "" };
    expect(proposalLine({ item: "OpenAPI spec", review: bare })).toBe(
      "OpenAPI spec: the change waits for review in Admin > Proposals",
    );
    expect(proposalHtml({ item: "OpenAPI spec", review: bare })).toBe(
      "OpenAPI spec: the change waits for review in Admin &gt; Proposals",
    );
    const relative = { ...review, summary: "", reviewUrl: "/admin/proposals?ws=docs&id=42" };
    expect(proposalHtml({ item: "OpenAPI spec", review: relative })).toBe(
      "OpenAPI spec: proposal 42 waits for review: /admin/proposals?ws=docs&amp;id=42",
    );
  });
});

describe("totalsLine", () => {
  it("names the proposed items only when a change waits for review", () => {
    const plain = result({ created: 1, skipped: 2, warnings: ["a", "b"] });
    expect(totalsLine([plain], false)).toBe(
      "Applied: 1 created, 0 updated, 0 removed, 2 unchanged, 0 failed, 2 warnings",
    );
    expect(totalsLine([result({ updated: 1, proposed: 3 })], true)).toBe(
      "Planned: 0 created, 1 updated, 3 proposed, 0 removed, 0 unchanged, 0 failed",
    );
  });
});

describe("jobFailure", () => {
  it("fails the job for failed items only when fail-on-error is true", () => {
    const results = [result({ failed: 2 }), result({ surface: "changelog", failed: 1 })];
    expect(jobFailure(results, true)).toBe("3 items failed to sync. See the job summary.");
    expect(jobFailure([result({ failed: 1 })], true)).toBe(
      "1 item failed to sync. See the job summary.",
    );
    expect(jobFailure(results, false)).toBeUndefined();
  });

  it("passes when nothing failed", () => {
    expect(jobFailure([result({ created: 3, warnings: ["note"] })], true)).toBeUndefined();
  });

  it("passes when changes wait for review", () => {
    expect(jobFailure([result({ proposed: 2 })], true)).toBeUndefined();
  });
});
