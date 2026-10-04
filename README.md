# ContextOwl Publish Action

Publish Markdown docs, a Keep a Changelog file, and an OpenAPI spec to
[ContextOwl](https://contextowl.co) from GitHub Actions. The action calls the
ContextOwl REST API with an agent key.

The [GitHub Action guide](https://developer.contextowl.co/docs/platform/github-action)
has the complete setup, configuration, permissions, and sync reference.

## Quick start

1. Create an agent key in **Admin > Settings > API**. Bind it to one workspace.
2. Store the key in a repository secret named `CONTEXTOWL_PAT`.
3. Add `.contextowl.yml` to the repository root:

   ```yaml
   docs:
     dir: docs
   changelog:
     file: CHANGELOG.md
   openapi:
     spec: openapi.yaml
   ```

4. Add `.github/workflows/contextowl.yml`:

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

| Input           | Default                 | Description                                                                                |
| --------------- | ----------------------- | ------------------------------------------------------------------------------------------ |
| `token`         | required                | Agent key that starts with `cowl_pat_`. Pass it from a secret.                             |
| `server-url`    | `https://contextowl.co` | Base URL of the ContextOwl instance. The action appends `/api/v1`.                         |
| `config`        | `.contextowl.yml`       | Path to the config file, relative to the repository root.                                  |
| `workspace`     | empty                   | Target workspace. It overrides the config file. Leave it empty for a workspace-bound key.  |
| `prune`         | `false`                 | Remove content that is no longer in the repository.                                        |
| `dry-run`       | `false`                 | Print the plan and make no changes.                                                        |
| `fail-on-error` | `true`                  | Fail the job when an item fails to sync. Set it to `false` to report failures as warnings. |

## Outputs

`created`, `updated`, `deleted`, `skipped`, and `failed` hold the totals for all
surfaces. The action also writes a summary table to the workflow run.

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
- When the key lacks `changelog.update`, the action sees only published
  changelog entries. It does not create a draft or a scheduled entry, because
  the next run cannot find that entry and creates it again. Each such version is
  a failed item. Add `changelog.update` to the key to sync these versions.
- When the server answers `402` or `403` to the OpenAPI upload, the action skips
  the OpenAPI step with a warning.

## Sync behavior

- The action skips content that did not change, so revision history and the
  audit log stay clean.
- The changelog sync reads all remote entries, 100 for each request. A file with
  many versions never creates duplicate entries. When the server does not
  support paging and returns 50 entries or more, the changelog sync stops before
  it changes an entry.
- A new article goes into its sidebar section when the action creates it.
- An article that an earlier run could not place goes into its section on the
  next run.
- The action never changes encrypted articles or generated OpenAPI pages.
- The repository is the source of truth. When the server refuses a new body as a
  large removal, the action sends it again with `allow_shrink` and logs a
  warning.
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
