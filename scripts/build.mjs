// Bundles the action into a single self-contained ESM file at dist/index.mjs.
// GitHub Actions runs `node dist/index.mjs`; committing the bundle is required
// for JavaScript actions so consumers do not run `npm install`.
import { build } from "esbuild";

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/index.mjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  minify: false,
  sourcemap: false,
  // Some bundled CJS dependencies call require(); provide it in the ESM output.
  banner: {
    js: "import { createRequire as __cowlCreateRequire } from 'module'; const require = __cowlCreateRequire(import.meta.url);",
  },
});

console.log("built dist/index.mjs");
