import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// A hosted assertion that waits for app text the app no longer renders fails only after a deploy
// and minutes of live setup. Every literal text locator in tests/hosted must therefore match the
// app source, unless Jira, fixture data or a computed value supplies the text.
const files = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
  );
const app = files('src')
  .filter((path) => /\.(ts|tsx|mjs)$/.test(path))
  .map((path) => readFileSync(path, 'utf8'))
  .join('\n');
const notAppText = new Map([
  ['/^(Agent Prompts, .*edit|Edit Agent Prompts)$/', 'Jira names the custom field editor'],
  ['/remove.*Error handling/i', 'the picker remove button for a fixture prompt'],
  ['/remove.*Unavailable prompt/i', 'the picker remove button; the label is a template literal'],
  ["'RELOAD-SENTINEL'", 'fixture text written by the test'],
  ["'2/5 selected · Unsaved changes'", 'computed selection count'],
  ["'1/5 selected · Unsaved changes'", 'computed selection count'],
  ['/^0\\/5 selected/', 'computed selection count'],
  ["'Owner only'", 'issue security level the access runner creates in Jira'],
  ["'Configure 2 spaces'", 'computed button label'],
  ['/^Agent Prompts to /', 'review change line; the field name is computed'],
  ['/^Description to /', 'review change line; the field name is computed'],
  ['/^Summary to /', 'review change line; the field name is computed'],
  ['/^Agent Prompts from /', 'review change line; the screen name is a template literal'],
  [
    '/^Agent Prompts on .+ \\(added outside the app\\)$/',
    'review change line; the screen name is a template literal',
  ],
  [
    '/^Agent Prompts on .+ \\(another configured space uses it\\)$/',
    'review change line; the screen name is a template literal',
  ],
  ["'Agent Prompts added'", 'shared screen effect; the field name is computed'],
  ['/^Blocked: /', 'review result; the reason is a template literal'],
  ['/^\\d+ of 20 screen changes made$/', 'computed step progress'],
  ["'Field Tab'", 'screen tab the setup runner creates in Jira'],
]);
const locator =
  /(?:getByText|\bline|getByLabel|getByPlaceholder|toContainText|toHaveText|hasText:|name:)\s*\(?\s*('(?:[^'\\]|\\.)*'|\/(?:[^/\\\n]|\\.)+\/[a-z]*)/g;

test('hosted text locators match text the app renders', () => {
  const found = files('tests/hosted')
    .filter((path) => path.endsWith('.mjs'))
    .flatMap((path) =>
      [...readFileSync(path, 'utf8').matchAll(locator)].map((m) => ({ path, literal: m[1] })),
    );
  assert.ok(found.length > 100, 'Locator scan found too few literals');
  const stale = found.filter(({ literal }) => {
    if (notAppText.has(literal)) return false;
    if (literal.startsWith("'")) return !app.includes(literal.slice(1, -1).replaceAll("\\'", "'"));
    const [, body, flags] = literal.match(/^\/(.*)\/([a-z]*)$/);
    return !new RegExp(body, flags.replace('g', '')).test(app);
  });
  assert.deepEqual(
    stale.map(({ path, literal }) => `${path}: ${literal}`),
    [],
    'Update the hosted test, or list the text with its source',
  );
  for (const literal of notAppText.keys())
    assert.ok(
      found.some((entry) => entry.literal === literal),
      `Unused exception ${literal}`,
    );
});

// Outside the Playwright test runner `expect` waits only 5 s, and hosted Jira often takes longer, so
// runners and support modules assert through the shared 30 s `expect`.
test('hosted runners assert with the shared expect timeout', () => {
  const direct = files('tests/hosted')
    .filter((path) => path.endsWith('.mjs') && !path.endsWith('.spec.mjs'))
    .filter((path) => path !== join('tests', 'hosted', 'support', 'expect.mjs'))
    .filter((path) =>
      /import\s*\{[^}]*\bexpect\b[^}]*\}\s*from\s*'(?:@playwright\/test|@srcplugins\/atlassian-forge-test-framework\/\w+)'/.test(
        readFileSync(path, 'utf8'),
      ),
    );
  assert.deepEqual(direct, [], 'Import expect from tests/hosted/support/expect.mjs');
});
