import { defineConfig } from 'vite'

export default defineConfig({
  // The tokenizer runs in a worker that is only created once a run has worked
  // examples to count. Without this, Vite's dev optimizer discovers
  // gpt-tokenizer at that moment and forces a full page reload, which drops
  // the session (the loaded sheet). Pre-bundling it keeps dev stable.
  optimizeDeps: { include: ['gpt-tokenizer', 'xlsx', 'jszip', 'jsonrepair'] },
  // Relative asset URLs: the site is served under a path on GitHub Pages
  // (stuartgeiger.com/<repo>/), and this works there, at the root, and from
  // a folder opened by hand. Routing is by hash, so no server rules needed.
  base: './',
  build: { chunkSizeWarningLimit: 900 },
})
