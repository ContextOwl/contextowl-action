import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncOpenapi } from "../src/sync/openapi.js";
import { nullLogger } from "../src/logger.js";
import { FakeCowl, apiError } from "./fake-cowl.js";

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

  it("skips with a warning on 402", async () => {
    const cowl = new FakeCowl({ legacy: true });
    cowl.planIncludesOpenapi = false;
    const spec = writeSpec("openapi: 3.0.0\n");
    const r = await syncOpenapi(cowl, nullLogger, opts(spec));

    expect(r.failed).toBe(0);
    expect(r.warnings).toEqual([
      "skipped the OpenAPI step because the workspace plan does not include the OpenAPI reference. Server error: 402 upgrade_required: your plan does not include this endpoint",
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
});
