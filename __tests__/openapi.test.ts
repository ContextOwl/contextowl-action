import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncOpenapi } from "../src/sync/openapi.js";
import { proposalLine } from "../src/sync/plan.js";
import { nullLogger } from "../src/logger.js";
import { FakeCowl, REVIEW_URL, apiError } from "./fake-cowl.js";

function writeSpec(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cowl-oas-"));
  const p = join(dir, "openapi.yaml");
  writeFileSync(p, body);
  return p;
}

const opts = (spec: string, over = {}) => ({ spec, workspace: undefined, dryRun: false, ...over });

describe("syncOpenapi", () => {
  it("attaches the spec and reports server stats", async () => {
    const cowl = new FakeCowl();
    cowl.openapiStats = { created: 3, updated: 1, deleted: 2 };
    const spec = writeSpec("openapi: 3.0.0\n");
    const r = await syncOpenapi(cowl, nullLogger, opts(spec));

    expect(cowl.openapiSpec).toContain("openapi: 3.0.0");
    expect([r.created, r.updated, r.deleted]).toEqual([3, 1, 2]);
  });

  it("reports an unchanged spec as skipped", async () => {
    const cowl = new FakeCowl();
    const spec = writeSpec("openapi: 3.0.0\n");
    await syncOpenapi(cowl, nullLogger, opts(spec));
    const r = await syncOpenapi(cowl, nullLogger, opts(spec));

    expect(r.skipped).toBe(1);
    expect(r.lines).toEqual(["OpenAPI spec unchanged: kept the generated pages"]);
  });

  it("does not attach in dry-run", async () => {
    const cowl = new FakeCowl();
    const spec = writeSpec("openapi: 3.0.0\n");
    await syncOpenapi(cowl, nullLogger, opts(spec, { dryRun: true }));
    expect(cowl.openapiSpec).toBeNull();
  });

  it("skips with a warning on 403, also when the message names no permission", async () => {
    for (const legacy of [false, true]) {
      const cowl = new FakeCowl({ legacy });
      cowl.perms.openapiAttach = false;
      const spec = writeSpec("openapi: 3.0.0\n");
      const r = await syncOpenapi(cowl, nullLogger, opts(spec));

      expect(r.failed).toBe(0);
      expect(r.warnings).toHaveLength(1);
      expect(r.warnings[0]).toMatch(
        /^skipped the OpenAPI step because the key lacks openapi\.attach\. Server error: 403 permission_denied: /,
      );
    }
  });

  it("skips with a warning when an older server plan-gates the attach with 402", async () => {
    const cowl = new FakeCowl({ legacy: true });
    cowl.planIncludesOpenapi = false;
    const spec = writeSpec("openapi: 3.0.0\n");
    const r = await syncOpenapi(cowl, nullLogger, opts(spec));

    expect(r.failed).toBe(0);
    expect(r.warnings).toEqual([
      "skipped the OpenAPI step because your plan does not include the OpenAPI reference on this server. Server error: 402 upgrade_required: your plan does not include this endpoint",
    ]);
  });

  it("counts any other error as a failed item", async () => {
    const cowl = new FakeCowl();
    cowl.failNext(
      "attachOpenapi",
      apiError("attach OpenAPI", 400, { code: "invalid_openapi", message: "not a spec" }),
    );
    const spec = writeSpec("nope\n");
    const r = await syncOpenapi(cowl, nullLogger, opts(spec));

    expect(r.failed).toBe(1);
    expect(r.failures).toEqual(["attach OpenAPI spec failed: 400 invalid_openapi: not a spec"]);
    expect(r.warnings).toEqual([]);
  });

  it("throws when the spec file is missing", async () => {
    const cowl = new FakeCowl();
    await expect(syncOpenapi(cowl, nullLogger, opts("/no/such/spec.yaml"))).rejects.toThrow(
      /not found/,
    );
  });

  it("counts a spec that waits for review as proposed and keeps one proposal", async () => {
    const cowl = new FakeCowl();
    cowl.writes = "review";
    cowl.openapiStats = { created: 3, updated: 1, deleted: 2 };
    const spec = writeSpec("openapi: 3.0.0\n");

    for (let run = 1; run <= 2; run++) {
      const r = await syncOpenapi(cowl, nullLogger, opts(spec, { note: "Commit 1a2b3c4" }));

      expect([r.created, r.updated, r.deleted, r.skipped, r.proposed]).toEqual([0, 0, 0, 0, 1]);
      expect(r.lines).toEqual([
        `OpenAPI spec: Attach the API reference: 3 new, 1 changed, 2 removed. Proposal 1 waits for review: ${REVIEW_URL}1`,
      ]);
      expect(r.proposals.map(proposalLine)).toEqual(r.lines);
    }
    expect(cowl.openapiSpec).toBeNull();
    expect(cowl.notes).toEqual(["Commit 1a2b3c4", "Commit 1a2b3c4"]);
  });

  it("withdraws the pending spec when the repository reverts it", async () => {
    const cowl = new FakeCowl();
    cowl.writes = "review";
    cowl.openapiSpec = "openapi: 3.0.0\n";
    const first = await syncOpenapi(cowl, nullLogger, opts(writeSpec("openapi: 3.1.0\n")));
    expect(first.proposed).toBe(1);

    const r = await syncOpenapi(cowl, nullLogger, opts(writeSpec("openapi: 3.0.0\n")));

    expect([r.skipped, r.proposed, r.failed]).toEqual([1, 0, 0]);
    expect(cowl.proposals.size).toBe(0);
    expect(cowl.withdrawn.map((p) => p.objectType)).toEqual(["openapi"]);
  });

  it("names the change without a link when the 202 answer has none", async () => {
    const cowl = new FakeCowl();
    cowl.attachOpenapi = async () => ({
      stats: null,
      unchanged: false,
      review: { id: 0, objectType: "", summary: "", outcome: "", reviewUrl: "" },
    });
    const r = await syncOpenapi(cowl, nullLogger, opts(writeSpec("openapi: 3.0.0\n")));

    expect([r.proposed, r.failed]).toEqual([1, 0]);
    expect(r.lines).toEqual(["OpenAPI spec: the change waits for review in Admin > Proposals"]);
  });
});
