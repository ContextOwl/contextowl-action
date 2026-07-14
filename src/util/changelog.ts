// Parses a "Keep a Changelog" style CHANGELOG.md into per-version entries.
//
// Each `## [version] - date` (or `## version`) heading starts an entry. The
// body runs until the next `##` heading. `### Added` / `### Changed` etc.
// subsection names become tags. An `[Unreleased]` section is skipped.

export interface ParsedChangelogEntry {
  /** Version string used as the entry title, e.g. "1.4.0". */
  version: string;
  /** RFC3339 timestamp derived from the heading date, if present. */
  publishedAt?: string;
  markdown: string;
  tags: string[];
}

const HEADING = /^##\s+(.+?)\s*$/;
const SUBHEADING = /^###\s+(.+?)\s*$/;

/** Extract the version and optional date from a `## ...` heading line. */
function parseHeading(text: string): { version: string; date?: string } {
  // Forms: "[1.2.0] - 2024-05-01", "[1.2.0]", "1.2.0 - 2024-05-01", "1.2.0"
  const bracket = text.match(/^\[([^\]]+)\](?:\s*-\s*(.+))?$/);
  if (bracket) return { version: bracket[1].trim(), date: bracket[2]?.trim() };
  const dash = text.match(/^(\S+)(?:\s*-\s*(.+))?$/);
  return { version: (dash?.[1] ?? text).trim(), date: dash?.[2]?.trim() };
}

function toRfc3339(date: string | undefined): string | undefined {
  if (!date) return undefined;
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString();
}

export function parseChangelog(text: string): ParsedChangelogEntry[] {
  const lines = text.split(/\r?\n/);
  const entries: ParsedChangelogEntry[] = [];

  let current: { version: string; date?: string; body: string[]; tags: string[] } | null = null;
  const flush = () => {
    if (!current) return;
    if (current.version.toLowerCase() !== "unreleased") {
      entries.push({
        version: current.version,
        publishedAt: toRfc3339(current.date),
        markdown: current.body.join("\n").trim(),
        tags: current.tags,
      });
    }
    current = null;
  };

  for (const line of lines) {
    const h = line.match(HEADING);
    if (h) {
      flush();
      const { version, date } = parseHeading(h[1]);
      current = { version, date, body: [], tags: [] };
      continue;
    }
    if (!current) continue; // preamble before the first version heading
    const sub = line.match(SUBHEADING);
    if (sub) current.tags.push(sub[1].trim());
    current.body.push(line);
  }
  flush();
  return entries;
}
