// Shared srcplugins file, synchronized across repositories.
import tseslint from 'typescript-eslint';
import hooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import a11y from 'eslint-plugin-jsx-a11y-x';
import forgeLocal, { testOnlyMessage } from './eslint-local-rules.mjs';

const a11yRecommended = a11y.configs.recommended;

// Shared across srcplugins repositories, so every path is a parameter: `base` prefixes Forge sources and `apps` prefixes app directories.
const uiConfigs = (tsx) => [
  {
    files: tsx,
    plugins: { 'react-hooks': hooks },
    // Enforce hook correctness. Compiler optimization rules need an adopted React compiler.
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    // DOM JSX in Custom UI. Capitalized UI Kit/Atlaskit components are not mapped to DOM
    // elements, so this does not establish UI Kit accessibility; hosted checks remain required.
    files: tsx,
    ...a11yRecommended,
    rules: {
      ...a11yRecommended.rules,
      'jsx-a11y-x/aria-role': ['error', { ignoreNonDOM: true }],
      'jsx-a11y-x/no-autofocus': ['error', { ignoreNonDOM: true }],
    },
  },
  {
    files: tsx,
    plugins: { 'forge-local': forgeLocal },
    rules: { 'forge-local/ui-kit-label': 'error' },
  },
];

const asAppMessage =
  'Use asUser. asApp needs an explicit invoking-user permission check, a behavioral denial test and a described lint exception.';

// These AST rules apply only to deployed source, not fixed-command tooling.
const deployedSecurity = {
  'no-console': 'error',
  'no-eval': 'error',
  'no-implied-eval': 'error',
  'no-new-func': 'error',
  'no-restricted-imports': [
    'error',
    {
      patterns: [
        {
          group: [
            'child_process',
            'node:child_process',
            'vm',
            'node:vm',
            'http',
            'node:http',
            'https',
            'node:https',
            'net',
            'node:net',
            'tls',
            'node:tls',
            'undici',
            'axios',
          ],
          message: 'No code execution or subprocesses in deployed apps.',
        },
        { regex: '^\\.\\.?/tests(/|$)|/tests/', message: testOnlyMessage },
      ],
      paths: [{ name: '@forge/api', importNames: ['asApp'], message: asAppMessage }],
    },
  ],
  'no-restricted-properties': [
    'error',
    { property: 'asApp', message: asAppMessage },
    { object: 'process', property: 'env', message: testOnlyMessage },
  ],
  'forge-local/strict-permission-check': 'error',
  'forge-local/host-terms': 'error',
  'forge-local/test-harness-names': 'error',
  'no-restricted-syntax': [
    'error',
    { selector: 'ImportExpression', message: 'Use static reviewed imports in deployed apps.' },
    {
      selector: "CallExpression[callee.name='require']",
      message: 'Use static reviewed imports in deployed apps.',
    },
    {
      selector:
        'MemberExpression[property.name=/^(innerHTML|outerHTML|insertAdjacentHTML|write|writeln)$/]',
      message: 'Use safe DOM text APIs; no HTML injection.',
    },
    {
      selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
      message: 'Do not inject HTML.',
    },
    {
      selector: "CallExpression[callee.name='fetch']",
      message: 'Use reviewed platform adapters; external egress requires explicit review.',
    },
  ],
};

/**
 * Standalone plugin repositories call this from their synchronized eslint.config.mjs.
 * @public
 * @param {{ base: string, apps: string, tsconfigRootDir: string, logger: string,
 *   deployed?: string[], nodeFixtures?: string[], defaultProject?: string[] }} options
 */
export function forgeConfig({
  base,
  apps,
  tsconfigRootDir,
  logger,
  deployed = [],
  nodeFixtures = [],
  defaultProject = [],
}) {
  const tsx = [`${base}**/*.tsx`];
  return [
    { ignores: [`${base}**/.forge/**`, `${base}**/.container-service-assets/**`] },
    ...tseslint.configs.recommended.map((config) => ({
      ...config,
      files: [`${base}**/*.{ts,tsx}`],
    })),
    { files: [...tsx, `${base}**/ui/*.js`], languageOptions: { globals: globals.browser } },
    // Scanner fixtures model Forge functions, which run on the Node runtime.
    ...(nodeFixtures.length
      ? [{ files: nodeFixtures, languageOptions: { globals: globals.node } }]
      : []),
    ...uiConfigs(tsx),
    {
      // Type-aware rules for deployed app source; these catch lost async errors.
      files: [`${apps}src/**/*.{ts,tsx,mjs}`],
      languageOptions: {
        parser: tseslint.parser,
        parserOptions: {
          // In-memory lint fixtures may use the default project; real source needs a tsconfig.
          projectService: defaultProject.length ? { allowDefaultProject: defaultProject } : true,
          tsconfigRootDir,
        },
      },
      plugins: { '@typescript-eslint': tseslint.plugin },
      rules: {
        '@typescript-eslint/no-floating-promises': 'error',
        '@typescript-eslint/no-misused-promises': 'error',
        '@typescript-eslint/await-thenable': 'error',
        '@typescript-eslint/switch-exhaustiveness-check': 'error',
        '@typescript-eslint/return-await': ['error', 'in-try-catch'],
      },
    },
    {
      files: [`${apps}src/**/*.{mjs,ts,tsx}`, `${apps}ui/*.js`, ...deployed],
      plugins: { 'forge-local': forgeLocal },
      rules: deployedSecurity,
    },
    // The redacting operational logger is the single reviewed console boundary.
    { files: [logger], rules: { 'no-console': 'off' } },
  ];
}
