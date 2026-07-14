import { describe, expect, it } from "vitest";
import { parseChangelog } from "../src/util/changelog.js";

const SAMPLE = `# Changelog

## [Unreleased]
- work in progress

## [1.2.0] - 2024-05-01
### Added
- New export button
### Fixed
- Crash on empty state

## [1.1.0] - 2024-04-01
Initial public release.
`;

describe("parseChangelog", () => {
  it("skips Unreleased and parses versioned entries", () => {
    const entries = parseChangelog(SAMPLE);
    expect(entries.map((e) => e.version)).toEqual(["1.2.0", "1.1.0"]);
  });

  it("converts the heading date to RFC3339", () => {
    const [first] = parseChangelog(SAMPLE);
    expect(first.publishedAt).toBe(new Date("2024-05-01").toISOString());
  });

  it("collects h3 subsection names as tags", () => {
    const [first] = parseChangelog(SAMPLE);
    expect(first.tags).toEqual(["Added", "Fixed"]);
  });

  it("captures the section body", () => {
    const last = parseChangelog(SAMPLE)[1];
    expect(last.markdown).toContain("Initial public release.");
    expect(last.markdown).not.toContain("## ");
  });

  it("handles bare versions without brackets or dates", () => {
    const entries = parseChangelog("## 2.0.0\nbig release\n");
    expect(entries).toHaveLength(1);
    expect(entries[0].version).toBe("2.0.0");
    expect(entries[0].publishedAt).toBeUndefined();
  });
});
