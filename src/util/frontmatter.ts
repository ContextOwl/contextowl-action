// Splits YAML front matter from a Markdown body. The front matter is the text
// between a `---` line at the top of the file and the next `---` line. A file
// without the closing line has no front matter, so all of it is the body.
import { parse } from "yaml";
import { type Rec, isRec } from "./json.js";

export interface FrontMatter {
  /** Empty when the front matter is missing, empty, or not a YAML mapping. */
  data: Rec;
  body: string;
}

const BOM = "\uFEFF";
const OPENING_LINE = /^---[ \t]*\r?\n/;
const CLOSING_LINE = /^---[ \t]*\r?(?:\n|$)/m;

/** Throws when the front matter is not valid YAML. */
export function parseFrontMatter(source: string, sourceRel: string): FrontMatter {
  const text = source.startsWith(BOM) ? source.slice(BOM.length) : source;
  const opening = OPENING_LINE.exec(text);
  if (!opening) return { data: {}, body: text };
  const rest = text.slice(opening[0].length);
  const closing = CLOSING_LINE.exec(rest);
  if (!closing) return { data: {}, body: text };

  // The YAML text starts after the opening `---`, so a YAML error gives the
  // line number of the file.
  let data: unknown;
  try {
    data = parse(text.slice(3, opening[0].length + closing.index));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`${sourceRel}: invalid front matter: ${reason}`);
  }
  return { data: isRec(data) ? data : {}, body: rest.slice(closing.index + closing[0].length) };
}
