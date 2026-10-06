import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedConfig } from "../src/config.js";
import { nullLogger } from "../src/logger.js";
import { runSync } from "../src/sync/index.js";
import { type SurfaceResult, emptyResult, jobFailure, totals } from "../src/sync/plan.js";
import { FakeCowl, apiError } from "./fake-cowl.js";

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "cowl-run-"));
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "docs", "intro.md"), "hello");
  writeFileSync(join(root, "CHANGELOG.md"), "## [1.0.0]\n### Added\n- first\n");
  return root;
}

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
});
