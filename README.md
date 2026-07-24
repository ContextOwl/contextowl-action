# ContextOwl Publish Action

Publish docs, changelog entries, and OpenAPI references to
[ContextOwl](https://contextowl.co) from GitHub Actions.

The [GitHub Action guide](https://developer.contextowl.co/docs/platform/github-action)
has the complete setup, configuration, permissions, and sync reference.

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
