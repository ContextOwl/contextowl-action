import { describe, expect, it } from "vitest";
import { parseArticle, titleFromFilename } from "../src/util/markdown.js";
import type { MarkdownFile } from "../src/util/walk.js";

const file = (rel: string): MarkdownFile => ({ path: `/root/${rel}`, rel });

describe("parseArticle", () => {
  it("prefers front-matter title, then H1, then filename", () => {
    expect(parseArticle(file("a.md"), "---\ntitle: FM\n---\n# H1\nbody").title).toBe("FM");
    expect(parseArticle(file("a.md"), "# H1 Title\nbody").title).toBe("H1 Title");
    expect(parseArticle(file("getting-started.md"), "body").title).toBe("Getting Started");
  });

  it("derives section from the parent directory", () => {
    expect(parseArticle(file("top.md"), "x").section).toBe("Guides");
    expect(parseArticle(file("api-reference/auth.md"), "x").section).toBe("Api Reference");
  });

  it("honors an explicit section and slug", () => {
    const a = parseArticle(file("guides/x.md"), "---\nsection: Core\nslug: my-slug\n---\nx");
    expect(a.section).toBe("Core");
    expect(a.slug).toBe("my-slug");
  });

  it("normalizes and validates status", () => {
    expect(parseArticle(file("a.md"), "---\nstatus: stable\n---\nx").status).toBe("STABLE");
    expect(() => parseArticle(file("a.md"), "---\nstatus: bogus\n---\nx")).toThrow(
      /invalid status/,
    );
  });

  it("strips front-matter from the body", () => {
    expect(parseArticle(file("a.md"), "---\ntitle: T\n---\nhello").markdown).toBe("hello");
  });
});

describe("titleFromFilename", () => {
  it("humanizes the basename", () => {
    expect(titleFromFilename("nested/my_cool-doc.mdx")).toBe("My Cool Doc");
  });
});
