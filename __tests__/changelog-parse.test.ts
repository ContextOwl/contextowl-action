import { describe, expect, it } from "vitest";
import { parseChangelog, tagForSection } from "../src/util/changelog.js";

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

  it("maps h3 subsection names to changelog tags", () => {
    const [first] = parseChangelog(SAMPLE);
    expect(first.tags).toEqual(["new", "fixed"]);
    expect(first.unmapped).toEqual([]);
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

  it("drops duplicate tags and keeps unknown names out of the tags", () => {
    const [entry] = parseChangelog(
      "## [3.0.0]\n### Removed\n- a\n### Deprecated\n- b\n### Notes\n- c\n### security\n- d\n",
    );
    expect(entry.tags).toEqual(["deprecated", "security"]);
    expect(entry.unmapped).toEqual(["Notes"]);
    expect(entry.markdown).toContain("### Notes");
  });

  it("treats headings inside fenced code blocks as body text", () => {
    const entries = parseChangelog(
      [
        "## [2.0.0] - 2024-06-01",
        "### Changed",
        "```markdown",
        "## Not a version",
        "### Not a tag",
        "```js",
        "```",
        "~~~",
        "## Still code",
        "~~~",
        "## [1.0.0] - 2024-01-01",
        "first",
      ].join("\n"),
    );
    expect(entries.map((e) => e.version)).toEqual(["2.0.0", "1.0.0"]);
    expect(entries[0].tags).toEqual(["improved"]);
    expect(entries[0].unmapped).toEqual([]);
    expect(entries[0].markdown).toContain("## Not a version");
    expect(entries[0].markdown).toContain("## Still code");
  });
});

describe("tagForSection", () => {
  it.each([
    ["Added", "new"],
    ["Changed", "improved"],
    ["Deprecated", "deprecated"],
    ["Removed", "deprecated"],
    ["Fixed", "fixed"],
    ["Security", "security"],
    [" ADDED ", "new"],
    ["features", "new"],
    ["Improvements", "improved"],
    ["Bugfix", "fixed"],
    ["new", "new"],
  ])("maps %j to %s", (name, tag) => {
    expect(tagForSection(name)).toBe(tag);
  });

  it("returns undefined for other names", () => {
    expect(tagForSection("Notes")).toBeUndefined();
    expect(tagForSection("constructor")).toBeUndefined();
  });
});
