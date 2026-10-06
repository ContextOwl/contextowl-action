import { describe, expect, it } from "vitest";
import { parseFrontMatter } from "../src/util/frontmatter.js";

describe("parseFrontMatter", () => {
  it.each([
    {
      name: "front matter and a body",
      source: "---\ntitle: T\n---\nbody",
      data: { title: "T" },
      body: "body",
    },
    { name: "no front matter", source: "# Title\nbody", data: {}, body: "# Title\nbody" },
    { name: "an empty front matter", source: "---\n---\nbody", data: {}, body: "body" },
    {
      name: "only comments in the front matter",
      source: "---\n# draft\n---\nbody",
      data: {},
      body: "body",
    },
    {
      name: "front matter that is not a mapping",
      source: "---\n- a\n---\nbody",
      data: {},
      body: "body",
    },
    {
      name: "a body that holds ---",
      source: "---\ntitle: T\n---\nintro\n\n---\n\nmore",
      data: { title: "T" },
      body: "intro\n\n---\n\nmore",
    },
    {
      name: "an empty front matter and a body that holds ---",
      source: "---\n---\nintro\n\n---\n\nmore",
      data: {},
      body: "intro\n\n---\n\nmore",
    },
    {
      name: "no front matter and a body that holds ---",
      source: "intro\n\n---\n\nmore",
      data: {},
      body: "intro\n\n---\n\nmore",
    },
    {
      name: "a --- rule at the top and no closing line",
      source: "---\n\nIntro.\n",
      data: {},
      body: "---\n\nIntro.\n",
    },
    {
      name: "front matter and no body",
      source: "---\ntitle: T\n---",
      data: { title: "T" },
      body: "",
    },
    {
      name: "CRLF line endings",
      source: "---\r\ntitle: T\r\n---\r\nbody\r\n",
      data: { title: "T" },
      body: "body\r\n",
    },
    {
      name: "a byte order mark",
      source: "\uFEFF---\ntitle: T\n---\nbody",
      data: { title: "T" },
      body: "body",
    },
    {
      name: "blanks after the delimiters",
      source: "--- \ntitle: T\n---\t\nbody",
      data: { title: "T" },
      body: "body",
    },
    {
      name: "a --- line that is not the first line",
      source: "\n---\ntitle: T\n---\nbody",
      data: {},
      body: "\n---\ntitle: T\n---\nbody",
    },
    {
      name: "a ---- rule on the first line",
      source: "----\ntitle: T\n----\nbody",
      data: {},
      body: "----\ntitle: T\n----\nbody",
    },
    {
      name: "a language name after the opening ---",
      source: "---js\n{ title: 'T' }\n---\nbody",
      data: {},
      body: "---js\n{ title: 'T' }\n---\nbody",
    },
    {
      name: "a --- after a U+2028 line separator in a value",
      source: "---\ntitle: T\nnote: a ---\n---\nbody",
      data: { title: "T", note: "a ---" },
      body: "body",
    },
    {
      name: "a --- after a lone CR",
      source: "---\ntitle: T\r---\nbody",
      data: {},
      body: "---\ntitle: T\r---\nbody",
    },
    {
      name: "a lone CR after the closing ---",
      source: "---\ntitle: T\n---\rbody",
      data: {},
      body: "---\ntitle: T\n---\rbody",
    },
    { name: "no text", source: "", data: {}, body: "" },
  ])("parses a file with $name", ({ source, data, body }) => {
    expect(parseFrontMatter(source, "a.md")).toEqual({ data, body });
  });

  it("names the file and the line of invalid YAML", () => {
    expect(() =>
      parseFrontMatter("---\ntitle: T\nsection: a: b\n---\nbody", "guides/a.md"),
    ).toThrow(/^guides\/a\.md: invalid front matter: .* at line 3,/);
  });
});
