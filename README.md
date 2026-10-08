# ContextOwl Publish Action

Publish Markdown docs, a Keep a Changelog file, and an OpenAPI spec to
[ContextOwl](https://contextowl.co) from GitHub Actions. The action calls the
ContextOwl REST API with an agent key.

The [GitHub Action guide](https://developer.contextowl.co/docs/platform/github-action)
has the complete setup, configuration, permissions, and sync reference.

## Quick start

1. Create an agent key in **Admin > Settings > API**. Bind it to one workspace.
2. If your organization reviews agent changes, select **Publish directly** when
   you create the key, or **Approve publishing** on its row. New organizations
   review agent changes. Without the approval, each publish waits in
   **Admin > Proposals**. See [Review](#review).
3. Store the key in a repository secret named `CONTEXTOWL_PAT`.
4. Add `.contextowl.yml` to the repository root:

   ```yaml
   docs:
     dir: docs
   changelog:
     file: CHANGELOG.md
   openapi:
     spec: openapi.yaml
   ```

5. Add `.github/workflows/contextowl.yml`:

   ```yaml
   name: Publish to ContextOwl
   on:
     push:
       branches: [main]
   jobs:
     publish:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - uses: ContextOwl/contextowl-action@v1
           with:
             token: ${{ secrets.CONTEXTOWL_PAT }}
   ```

A workflow that passes a secret named `CONTEXTOWL_TOKEN` keeps working. The
action reads the key from the `token` input, so you choose the secret name.

## Inputs

| Input           | Default                 | Description                                                                                             |
| --------------- | ----------------------- | ------------------------------------------------------------------------------------------------------- |
| `token`         | required                | Agent key that starts with `cowl_pat_`. Pass it from a secret.                                          |
| `server-url`    | `https://contextowl.co` | Base URL of the ContextOwl instance. The action appends `/api/v1`.                                      |
| `config`        | `.contextowl.yml`       | Path to the config file, relative to the repository root.                                               |
| `workspace`     | empty                   | Target workspace. It overrides the config file. Leave it empty for a workspace-bound key.               |
| `prune`         | `false`                 | Remove content that is no longer in the repository.                                                     |
| `dry-run`       | `false`                 | Print the plan and make no changes.                                                                     |
| `fail-on-error` | `true`                  | Fail the job when an item fails to sync. Set it to `false` to report failures as warnings.              |
| `allow-shrink`  | `false`                 | Accept a new article body that removes most of the current text. See [Large removals](#large-removals). |

## Outputs

`created`, `updated`, `deleted`, `skipped`, `failed`, and `proposed` hold the
totals for all surfaces. A surface that stops before it finishes counts as 1 in
`failed`. `proposed` counts the items with a change that waits for review. See
[Review](#review). The action also writes a summary table to the workflow run.

## Front matter

Each Markdown file in the docs directory becomes one article. Front matter is
optional. It is the YAML text between a `---` line at the top of the file and
the next `---` line. The
[GitHub Action guide](https://developer.contextowl.co/docs/platform/github-action#docs)
lists the fields.

- The action reads the front matter as YAML 1.2. A date-like value such as
  `version: 2024-06-20` stays text.
- A file that starts with a `---` line and has no closing `---` line has no
  front matter. The whole file becomes the article body.
- The opening line must be `---` alone. The action does not read `---js` or
  front matter in another language.
- Invalid YAML in the front matter stops the docs sync. The error names the
  file and the line.

## Changelog tags

Each `## [version] - date` heading becomes one changelog entry. Before the
action sends an entry, it maps each `###` subsection name to a ContextOwl tag.
The match ignores case.

| Subsection   | Tag          |
| ------------ | ------------ |
| `Added`      | `new`        |
| `Changed`    | `improved`   |
| `Deprecated` | `deprecated` |
| `Removed`    | `deprecated` |
| `Fixed`      | `fixed`      |
| `Security`   | `security`   |

The tag names and the server aliases also work as subsection names: `New`,
`Improved`, `Feature`, `Features`, `Improvement`, `Improvements`, `Fix`,
`Fixes`, `Bugfix`, and `Deprecation`. Any other subsection name gets no tag. The
action logs a warning for that name and still syncs the entry.

## Failures and warnings

The action writes the job summary first. Then it sets the job result:

- When an item fails to sync and `fail-on-error` is `true`, the job fails. An
  item is one article, one changelog entry, or the OpenAPI spec. With
  `fail-on-error: false`, a failed item is a warning, and the `failed` output
  holds the count.
- When an error stops a whole surface, the job fails for every value of
  `fail-on-error`. A rejected key and a failed list request are examples. The
  other surfaces still run.
- When the key lacks `article.publish`, `changelog.publish`, or
  `changelog.delete`, the action logs a warning and continues without that step.
  Without `changelog.publish`, new changelog entries stay drafts.
- When the server answers `402` or `403` to a new sidebar section or to the move
  of an article, the action still syncs the article content. The article keeps
  its place in the sidebar and counts as created, updated, or unchanged, not as
  failed. A new article that the action cannot place has no section. When the
  action publishes it, the server puts it in the first section.
- Without `section.create`, the action logs one warning per run that names the
  sections. To place the articles, add `section.create` to the key or create the
  sections in the app. The next run then moves the articles into them.
- Without `article.place`, the action logs one warning per run that names the
  articles. To move them, add `article.place` to the key or move them in the
  app. A new article in a section that exists still goes into it, because the
  create request places it.
- The server answers `402` when the plan does not allow a step, for example a
  move into a section that is not public. The warning then says that the plan
  does not allow the step.
- When the key lacks `changelog.update`, the action sees only published
  changelog entries. It does not create a draft or a scheduled entry, because
  the next run cannot find that entry and creates it again. Each such version is
  a failed item. Add `changelog.update` to the key to sync these versions.
- When the server answers `402` or `403` to the OpenAPI upload, the action skips
  the OpenAPI step with a warning.

### Large removals

The server refuses a new article body that removes more than half of the
current text and more than 2,000 characters. This guards a live article against
a truncated or broken file. The article keeps its current body and counts as a
failed item.

To accept such a change, set `allow-shrink: true`. The action then sends the
body again with `allow_shrink` and logs a warning.

## Review

An organization can review agent changes. When the review is on and the key is
not a publishing key, the server answers `202` to these writes. The change then
waits in **Admin > Proposals** until an editor approves it:

- A change to a published article, the publish of a draft, and the move of a
  published article.
- A new published changelog entry, a change to a published entry, and the
  publish of a draft entry.
- The prune of a published article or changelog entry.
- An OpenAPI spec that changes the API reference.

New drafts and new sections still sync at once. The action counts an item with
a change that waits as proposed, not as created, updated, or removed. A new
article whose publish waits also counts as proposed. Its draft already exists
in the app. The job summary lists each proposal with its review link, for
example:

```text
"Getting Started": Publish getting-started: DRAFT to STABLE. Proposal 42 waits for review: https://contextowl.co/admin/proposals?ws=docs&id=42
```

A change that waits does not fail the job. The next run sends the same change
again, and the server keeps one proposal for it. An article whose move waits
keeps its section until an editor approves the move.

Each write that can wait for review sends a note for the reviewer: the subject
of the pushed commit and a link to the commit. The action reads
`GET /api/v1/me` first and sends the note only when the server returns
`writes`, because older servers reject an unknown field. When the changes of
the key wait for review, the action logs a hint at the start of the run.

To publish on every merge, approve the key as a publishing key in
**Admin > Settings > API**.

## Sync behavior

- The action skips content that did not change, so revision history and the
  audit log stay clean.
- The changelog sync reads all remote entries, 100 for each request. A file with
  many versions never creates duplicate entries. When the server does not
  support paging and returns 50 entries or more, the changelog sync stops before
  it changes an entry.
- A new article goes into its sidebar section when the action creates it. When
  the section does not exist, the action creates it. This needs
  `section.create`.
- An article that an earlier run could not place goes into its section on the
  next run. To move an article, the action needs `article.place`.
- The action never changes encrypted articles or generated OpenAPI pages.
- When the server answers `429`, the action waits for the `Retry-After` time and
  sends the request again, up to 3 times. A read request does the same for
  `502`, `503`, and `504`.

## Development

```bash
npm ci
npm run typecheck   # tsc, no emit
npm test            # vitest, with an in-memory fake API and no network or key
npm run build       # bundle to dist/index.mjs, which is committed
npm run all         # format check, typecheck, tests, and build
```

The bundled `dist/index.mjs` is committed, and CI fails when it does not match
the source. Run `npm run build` and commit the result with each source change.

## License

[MIT](./LICENSE)
