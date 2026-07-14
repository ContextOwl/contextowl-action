import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncOpenapi } from "../src/sync/openapi.js";
import { nullLogger } from "../src/logger.js";
import { FakeCowl } from "./fake-cowl.js";

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

  it("does not attach in dry-run", async () => {
    const cowl = new FakeCowl();
    const spec = writeSpec("openapi: 3.0.0\n");
    await syncOpenapi(cowl, nullLogger, opts(spec, { dryRun: true }));
    expect(cowl.openapiSpec).toBeNull();
  });

  it("warns instead of failing when the token cannot attach", async () => {
    const cowl = new FakeCowl();
    cowl.perms.openapiAttach = false;
    const spec = writeSpec("openapi: 3.0.0\n");
    const r = await syncOpenapi(cowl, nullLogger, opts(spec));

    expect(r.warnings.join(" ")).toMatch(/openapi\.attach/);
  });

  it("throws when the spec file is missing", async () => {
    const cowl = new FakeCowl();
    await expect(syncOpenapi(cowl, nullLogger, opts("/no/such/spec.yaml"))).rejects.toThrow(
      /not found/,
    );
  });
});
