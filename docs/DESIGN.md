# Design: contextowl-action

Status: v1. A GitHub Action that publishes a repository's docs, changelog, and
OpenAPI spec to a ContextOwl workspace.

## Goal

Let anyone keep their published ContextOwl documentation in sync with their
repository from CI, for three surfaces: a Markdown docs tree, a Keep a Changelog
file, and an OpenAPI spec.

## Key decisions

- **Transport: the ContextOwl MCP endpoint.** The only token-authenticated write
  path is the MCP server at `<server>/mcp` (bearer `cowl_pat_...`), a standard MCP
  Streamable HTTP server. The action drives it with the official
  `@modelcontextprotocol/sdk` client. No backend changes are required.
- **Runtime: a Node 24 TypeScript action** with a committed `dist/index.mjs`
  bundle. Runs on all runners, no Docker cold start.
- **Config: a committed `.contextowl.yml`** declaring the docs dir, changelog
  file, OpenAPI spec, target workspace, and prune flag. Versioned and reviewable.
- **Sync: upsert by default, opt-in prune.** Unchanged content is skipped to
  avoid churning revision history and the audit trail.

## Platform constraints that shaped the design

1. **No `delete_article` tool.** The MCP surface exposes `delete_changelog` but no
   article delete, and `update_article` has no archive flag. So docs prune is a
   soft-remove: set `status: DEPRECATED` (requires `article.publish`). Changelog
   prune is a hard delete.
2. **`create_article` derives the slug from the title.** The action therefore keys
   article identity on the exact title (with an optional front-matter `slug`
   override), reconciled against `list_articles`.
3. **`list_articles` returns capitalized JSON keys** (a bespoke Go struct), while
   `list_changelog` returns the model's lowercase-tagged shape. The client parses
   tool JSON case-insensitively.
4. **Encrypted and OpenAPI-generated articles are untouchable.** Encrypted pages
   are excluded from matching and prune; OpenAPI pages reject edits (handled as a
   warning).

## Architecture

```
action.yml            node24 -> dist/index.mjs
src/
  main.ts             inputs, connect, run, summary, outputs
  config.ts           parse/validate .contextowl.yml + input overrides (zod)
  logger.ts           logging seam (real impl wraps @actions/core)
  types.ts            domain types + the Cowl gateway interface + CowlToolError
  mcp/client.ts       CowlClient: real gateway over the MCP SDK
  sync/
    index.ts          preflight + run docs/changelog/openapi in order
    docs.ts           Markdown tree -> articles
    changelog.ts      Keep a Changelog -> entries
    openapi.ts        spec -> attach/regenerate
    plan.ts           per-surface result accounting
  util/               walk, markdown front-matter, changelog parser, json, concurrency
__tests__/            vitest against an in-memory FakeCowl (no network/token)
```

### The Cowl gateway seam

`src/types.ts` defines `Cowl`, a typed interface over the MCP tools the action
uses (`listArticles`, `createArticle`, `createChangelog`, `attachOpenapi`, ...).
`CowlClient` is the real implementation; tests inject `FakeCowl`, which mirrors
the server's semantics including permission denials. Sync modules depend only on
`Cowl`, never on the MCP SDK — so all sync logic is unit-tested without a network.

### Sync algorithm (per surface)

1. Enumerate the desired state from the repo.
2. Enumerate the current state from ContextOwl (`list_articles` / `list_changelog`).
3. Match desired to remote (title/slug for docs; version for changelog).
4. Create / update / skip-unchanged; place articles into sections.
5. Prune orphans if enabled (deprecate docs, delete changelog entries).

`dry-run` computes and prints the plan using only read calls.

### Error handling

- Config, auth, tenant (404), and missing-path errors fail the action.
- Per-item write failures become warnings; the run continues.
- Missing optional permissions (`article.publish`, `changelog.publish`,
  `changelog.delete`, `openapi.attach`) degrade gracefully with a warning.

## Known limitations (v1)

- Docs prune deprecates rather than deletes (platform has no article delete).
- A pre-existing but empty section may be duplicated, since sections are
  discovered from placed articles.
- A `version`-only front-matter change does not, by itself, trigger an update
  (no remote version is exposed by `list_articles` to diff against).
- Wire-level compatibility with a live instance is validated manually; unit tests
  cover logic against the fake gateway.

## Release

Semver tags (`vX.Y.Z`) trigger a workflow that moves the sliding major tag
(`v1`). Marketplace listing is a one-time manual publish in the GitHub UI.
