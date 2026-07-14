# ContextOwl Publish Action

Publish your **docs**, **changelog**, and **OpenAPI reference** to
[ContextOwl](https://contextowl.co) from CI. Point the action at a config file,
give it a token, and every push keeps your published documentation in sync with
your repository.

- **Docs** — a tree of Markdown files becomes articles, organized into sidebar sections.
- **Changelog** — a [Keep a Changelog](https://keepachangelog.com) file becomes changelog entries.
- **OpenAPI** — a 3.x spec regenerates your API reference pages.

It talks to ContextOwl over the authenticated MCP endpoint, so it works against
the hosted service or any self-hosted instance.

## Quick start

1. **Create a token.** In ContextOwl, open your organization's API keys and mint
   a personal access token (`cowl_pat_...`) with the permissions below. Bind it
   to a single workspace for the tightest scope.

2. **Store it as a secret** named `CONTEXTOWL_TOKEN` in your repository.

3. **Add `.contextowl.yml`** to your repo root:

   ```yaml
   workspace: prod
   docs:
     dir: docs
   changelog:
     file: CHANGELOG.md
   openapi:
     spec: openapi.yaml
   ```

4. **Add the workflow** (`.github/workflows/contextowl.yml`):

   ```yaml
   name: Publish to ContextOwl
   on:
     push:
       branches: [main]
       paths: ["docs/**", "CHANGELOG.md", "openapi.yaml", ".contextowl.yml"]
   jobs:
     publish:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - uses: ContextOwl/contextowl-action@v1
           with:
             token: ${{ secrets.CONTEXTOWL_TOKEN }}
   ```

That's it. Push to `main` and your docs publish.

## Inputs

| Input        | Required | Default                       | Description                                                        |
| ------------ | -------- | ----------------------------- | ------------------------------------------------------------------ |
| `token`      | yes      | —                             | ContextOwl PAT (`cowl_pat_...`). Always pass via a secret.         |
| `server-url` | no       | `https://app.contextowl.co`   | Base URL of your instance. The action appends `/mcp`.              |
| `config`     | no       | `.contextowl.yml`             | Path to the config file, relative to the repo root.                |
| `workspace`  | no       | —                             | Target workspace. Overrides the config; omit for workspace tokens. |
| `prune`      | no       | `false`                       | Remove content no longer in the repo. See [Prune](#prune).         |
| `dry-run`    | no       | `false`                       | Compute and print the plan without making any changes.             |

### Outputs

`created`, `updated`, `deleted`, `skipped` — totals across all surfaces. A
summary table is also written to the workflow run.

## Configuration reference

Every surface is optional; configure only what you use. At least one is required.

```yaml
workspace: prod # optional if the token is workspace-bound
docs:
  dir: docs # directory of Markdown files
changelog:
  file: CHANGELOG.md # Keep a Changelog format
openapi:
  spec: openapi.yaml # OpenAPI 3.x (JSON or YAML)
prune: false # also settable via the `prune` input
```

### Docs

Each `.md`/`.mdx` file becomes one article. Front-matter is optional:

```markdown
---
title: Getting Started # defaults to the first H1, then the filename
section: Guides # defaults to the parent directory name
status: STABLE # DRAFT | IN REVIEW | BETA | STABLE | DEPRECATED (defaults to DRAFT)
slug: getting-started # optional explicit slug
version: v2 # optional doc version label
---

# Getting Started

...
```

- Articles are **matched by title** (or an explicit front-matter `slug`), so the
  action recognizes existing pages across runs.
- The parent directory becomes the sidebar **section**; new sections are created
  as needed.
- Setting a `status` other than `DRAFT` requires the `article.publish`
  permission. Without it the article stays a draft and the action warns.

### Changelog

A single file in Keep a Changelog format. Each version heading is one entry:

```markdown
## [1.4.0] - 2026-02-01

### Added

- Dark mode

### Fixed

- Export crash
```

- The version (`1.4.0`) is the entry title; entries are matched by version.
- The date becomes the publish date; `### Added` / `### Fixed` etc. become tags.
- An `[Unreleased]` section is ignored.
- Publishing requires `changelog.publish`; otherwise entries are created as drafts.

### OpenAPI

The spec file is uploaded to ContextOwl, which (re)generates the API reference
pages and prunes pages for endpoints you removed. Requires `openapi.attach`.

## Sync behavior

- **Upsert by default.** New content is created, changed content is updated, and
  **unchanged content is skipped** so your revision history and audit trail stay clean.
- **Encrypted articles and OpenAPI-generated pages are never modified** by the docs sync.

### Prune

Off by default. When enabled (via the `prune` input or `prune: true` in config),
content that is **no longer present in the repo** is removed:

- **Docs** are set to `DEPRECATED` (ContextOwl has no hard-delete for articles;
  requires `article.publish`).
- **Changelog** entries are **deleted** (requires `changelog.delete`).

> Prune treats the repo as the source of truth for the whole workspace. Articles
> and entries created elsewhere (e.g. in the ContextOwl editor) will be
> deprecated/deleted if they are not in the repo. Run with `dry-run: true` first.

## Recommended token permissions

| Surface   | Minimum                                | Add for publish      | Add for prune        |
| --------- | -------------------------------------- | -------------------- | -------------------- |
| Docs      | `article.read`, `article.create`, `article.update`, `section.create`, `article.place` | `article.publish` | `article.publish` |
| Changelog | `changelog.read`, `changelog.create`, `changelog.update` | `changelog.publish` | `changelog.delete` |
| OpenAPI   | `openapi.read`, `openapi.attach`, `openapi.sync` | —              | —                    |

Missing an optional permission degrades gracefully (a warning, not a failure).

## Dry run

```yaml
- uses: ContextOwl/contextowl-action@v1
  with:
    token: ${{ secrets.CONTEXTOWL_TOKEN }}
    dry-run: true
```

Prints exactly what would be created, updated, skipped, or removed — no changes made.

## Self-hosted

Set `server-url` to your instance's base URL:

```yaml
with:
  token: ${{ secrets.CONTEXTOWL_TOKEN }}
  server-url: https://docs.your-company.com
```

## Development

```bash
npm install
npm run typecheck   # tsc, no emit
npm test            # vitest (in-memory fake gateway, no network/token)
npm run build       # bundle to dist/index.mjs (committed)
npm run all         # format check + typecheck + test + build
```

The bundled `dist/index.mjs` is committed and CI fails if it drifts from source.
Run `npm run build` and commit the result with any source change.

## License

[MIT](./LICENSE)
