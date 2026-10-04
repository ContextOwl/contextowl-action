// Parses a "Keep a Changelog" style CHANGELOG.md into per-version entries.
//
// Each `## [version] - date` (or `## version`) heading starts an entry. The
// body runs until the next `##` heading. `### Added` / `### Changed` etc.
// subsection names map to ContextOwl changelog tags. An `[Unreleased]` section
// is skipped. Headings inside fenced code blocks are body text.

export interface ParsedChangelogEntry {
  /** Version string used as the entry title, e.g. "1.4.0". */
  version: string;
  /** RFC3339 timestamp derived from the heading date, if present. */
  publishedAt?: string;
  markdown: string;
  /** Tags mapped from the `###` subsection names, without duplicates. */
  tags: string[];
  /** `###` subsection names that map to no tag. */
  unmapped: string[];
}

// Lowercase subsection name to tag: the Keep a Changelog names, the tags
// themselves, and the aliases the server accepts.
const SECTION_TAGS = new Map<string, string>([
  ["added", "new"],
  ["new", "new"],
  ["feature", "new"],
  ["features", "new"],
  ["changed", "improved"],
  ["improved", "improved"],
  ["improvement", "improved"],
  ["improvements", "improved"],
  ["fixed", "fixed"],
  ["fix", "fixed"],
  ["fixes", "fixed"],
  ["bugfix", "fixed"],
  ["deprecated", "deprecated"],
  ["deprecation", "deprecated"],
  ["removed", "deprecated"],
  ["security", "security"],
]);

/** The tag for a `###` subsection name, case-insensitive, or undefined when none fits. */
export function tagForSection(name: string): string | undefined {
  return SECTION_TAGS.get(name.trim().toLowerCase());
}

const HEADING = /^##\s+(.+?)\s*$/;
const SUBHEADING = /^###\s+(.+?)\s*$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

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

  let current: {
    version: string;
    date?: string;
    body: string[];
    tags: string[];
    unmapped: string[];
  } | null = null;
  const flush = () => {
    if (!current) return;
    if (current.version.toLowerCase() !== "unreleased") {
      entries.push({
        version: current.version,
        publishedAt: toRfc3339(current.date),
        markdown: current.body.join("\n").trim(),
        tags: current.tags,
        unmapped: current.unmapped,
      });
    }
    current = null;
  };

  let fence = "";
  for (const line of lines) {
    const marker = line.match(FENCE)?.[1];
    if (fence) {
      const closes = marker?.[0] === fence[0] && marker.length >= fence.length;
      if (closes && line.trim() === marker) fence = "";
    } else if (marker) {
      fence = marker;
    } else {
      const h = line.match(HEADING);
      if (h) {
        flush();
        const { version, date } = parseHeading(h[1]);
        current = { version, date, body: [], tags: [], unmapped: [] };
        continue;
      }
      const sub = current ? line.match(SUBHEADING) : null;
      if (current && sub) {
        const name = sub[1].trim();
        const tag = tagForSection(name);
        if (!tag) current.unmapped.push(name);
        else if (!current.tags.includes(tag)) current.tags.push(tag);
      }
    }
    current?.body.push(line);
  }
  flush();
  return entries;
}
