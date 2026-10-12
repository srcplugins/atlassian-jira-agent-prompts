import { build } from 'esbuild';
import { mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const directory = fileURLToPath(new URL('.', import.meta.url));
mkdirSync(`${directory}static`, { recursive: true });
copyFileSync(`${directory}ui/index.html`, `${directory}static/index.html`);
await build({
  entryPoints: [`${directory}src/field-entry.tsx`],
  outfile: `${directory}static/field.js`,
  bundle: true,
  minify: true,
  sourcemap: false,
  target: ['chrome120'],
  define: { 'process.env.NODE_ENV': '"production"' },
});
console.log('Agent Prompts Custom UI field built.');
