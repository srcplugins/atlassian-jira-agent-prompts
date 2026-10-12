// Shared srcplugins file, synchronized across repositories.
import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';

// Dead-code scan for a Forge plugin. Forge loads functions and UI Kit resources from manifest.yml
// and Custom UI bundles from build-ui.mjs, none of which knip can discover, so they are listed
// here as entries. Everything else must be reachable from an entry or from the tests.
const manifest = parse(readFileSync('manifest.yml', 'utf8'));
// Hosted journeys and runners (tests/hosted) are entries too.
const entry = ['tests/*.test.mjs', 'tests/hosted/*.mjs', 'config/*.mjs', 'playwright.config.mjs'];
for (const fn of manifest.modules?.function ?? [])
  entry.push(`src/${String(fn.handler).split('.')[0]}.{ts,tsx,mjs,js}`);
for (const resource of manifest.resources ?? [])
  if (/\.[jt]sx?$/.test(resource.path)) entry.push(resource.path);
if (existsSync('build-ui.mjs'))
  for (const [, path] of readFileSync('build-ui.mjs', 'utf8').matchAll(
    /\$\{directory\}((?:ui|src)\/[\w./-]+\.(?:m?js|tsx?))`/g,
  ))
    entry.push(path);

export default {
  entry,
  project: ['{src,tests,config}/**/*.{mjs,js,ts,tsx}', '*.{mjs,js}'],
  // Loading the Playwright configuration needs the private test configuration; the specs are
  // entries above. The Forge CLI runs as a binary through config/forge.mjs.
  playwright: false,
  ignoreDependencies: ['@forge/cli'],
  // Shared srcplugins helpers are a library: an unused helper file is
  // reported (delete it), but a used helper keeps exports that other plugins need.
  ignoreIssues: {
    'src/shared/**': ['exports'],
    'tests/support/{forge-contract,contracts}.mjs': ['exports'],
  },
};
