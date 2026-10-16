import { defineConfig } from 'tsdown'

// The bundle keeps the host contract: a single script wrapped in
// `window.__ModuleLoader__.load({ id: 'dsh-review-panel', factory })` whose
// module table only provides `react` / `react/jsx-runtime` (both external).
// The banner/footer inject that wrapper around rolldown's CJS chunk.
export default defineConfig({
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: ['cjs'],
  platform: 'browser',
  deps: {
    neverBundle: ['react', 'react/jsx-runtime'],
  },
  outExtensions: () => ({ js: '.js' }),
  minify: false,
  sourcemap: false,
  dts: false,
  banner: `window.__ModuleLoader__.load({
  id: 'dsh-review-panel',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;`,
  footer: `return module.exports;
  },
});`,
})
