// Recursively lists Markdown files under a directory.
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const MARKDOWN_EXT = /\.mdx?$/i;

export interface MarkdownFile {
  /** Absolute path on disk. */
  path: string;
  /** Path relative to the walked root, using forward slashes. */
  rel: string;
}

/** Return every .md/.mdx file under `root`, sorted by relative path. */
export function walkMarkdown(root: string): MarkdownFile[] {
  const out: MarkdownFile[] = [];
  const visit = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name.startsWith(".")) continue; // skip dotfiles/dirs
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        visit(full);
      } else if (MARKDOWN_EXT.test(name)) {
        out.push({ path: full, rel: relative(root, full).split("\\").join("/") });
      }
    }
  };
  visit(root);
  out.sort((a, b) => a.rel.localeCompare(b.rel));
  return out;
}
