// Shared srcplugins file, synchronized across repositories.
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import prettier from 'eslint-config-prettier/flat';
import comments from '@eslint-community/eslint-plugin-eslint-comments/configs';
import { fileURLToPath } from 'node:url';
import { forgeConfig } from './config/forge-eslint.mjs';

export default defineConfig([
  globalIgnores(['node_modules/**', 'static/**', '.forge/**', '.local/**', 'coverage/**']),
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx}'],
    extends: [js.configs.recommended, comments.recommended],
    linterOptions: { reportUnusedDisableDirectives: 'error', reportUnusedInlineConfigs: 'error' },
    // Every lint exception must state its reason next to the code it exempts.
    rules: { '@eslint-community/eslint-comments/require-description': 'error' },
  },
  {
    files: ['**/*.{mjs,cjs}', 'src/index.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    // Hosted journeys run in Node and pass callbacks into the browser page.
    files: ['tests/hosted/**/*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    // Playwright fixture dependency injection requires an object parameter, even when empty.
    rules: { 'no-empty-pattern': ['error', { allowObjectPatternsAsParameters: true }] },
  },
  ...forgeConfig({
    base: '',
    apps: '',
    tsconfigRootDir: fileURLToPath(new URL('./', import.meta.url)),
    logger: 'src/shared/logging.mjs',
  }),
  prettier,
]);
