import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mcpUrlFrom, parseConfig, resolveConfig } from "../src/config.js";

describe("parseConfig", () => {
  it("accepts a valid config", () => {
    const cfg = parseConfig("workspace: prod\ndocs:\n  dir: docs\nprune: true\n");
    expect(cfg.workspace).toBe("prod");
    expect(cfg.docs?.dir).toBe("docs");
    expect(cfg.prune).toBe(true);
  });

  it("rejects unknown keys", () => {
    expect(() => parseConfig("nope: 1\n")).toThrow(/Invalid config/);
  });

  it("rejects a non-url server", () => {
    expect(() => parseConfig("server: not-a-url\ndocs:\n  dir: d\n")).toThrow(/Invalid config/);
  });
});

describe("mcpUrlFrom", () => {
  it("appends /mcp and trims trailing slashes", () => {
    expect(mcpUrlFrom("https://x.co")).toBe("https://x.co/mcp");
    expect(mcpUrlFrom("https://x.co/")).toBe("https://x.co/mcp");
    expect(mcpUrlFrom("https://x.co///")).toBe("https://x.co/mcp");
  });
});

describe("resolveConfig", () => {
  const write = (body: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "cowl-cfg-"));
    const p = join(dir, ".contextowl.yml");
    writeFileSync(p, body);
    return p;
  };

  const inputs = (configPath: string, over: Record<string, unknown> = {}) => ({
    token: "cowl_pat_x",
    serverUrl: "https://contextowl.co",
    configPath,
    workspace: "",
    prune: false,
    dryRun: false,
    ...over,
  });

  it("errors when no surface is configured", () => {
    const p = write("workspace: prod\n");
    expect(() => resolveConfig(inputs(p))).toThrow(/at least one of/);
  });

  it("errors when the file is missing", () => {
    expect(() => resolveConfig(inputs("/no/such/file.yml"))).toThrow(/not found/);
  });

  it("lets the input override the config workspace and enables prune from either", () => {
    const p = write("workspace: prod\ndocs:\n  dir: docs\nprune: true\n");
    const cfg = resolveConfig(inputs(p, { workspace: "staging" }));
    expect(cfg.workspace).toBe("staging");
    expect(cfg.prune).toBe(true);
    expect(cfg.mcpUrl).toBe("https://contextowl.co/mcp");
  });
});
