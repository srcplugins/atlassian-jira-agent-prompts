import './support/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { forgeContract } from './support/forge-contract.mjs';
const { sourceContent } = await import('../src/prompt-text.ts');
const { registerRovo } = await import('../src/integration.ts');
const paragraph = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const item = (...content) => ({ type: 'listItem', content });
const doc = (...content) => ({ type: 'doc', version: 1, content });
const numbered = doc(paragraph('Perform step 5 only.'), {
  type: 'orderedList',
  attrs: { order: 4 },
  content: [item(paragraph('Remove stale cache files.')), item(paragraph('Rebuild the index.'))],
});
const numberedText = 'Perform step 5 only.\n\n4. Remove stale cache files.\n5. Rebuild the index.';

test('plain-text prompt reads preserve the starting number and each referenced step', () => {
  assert.equal(sourceContent(numbered), numberedText);
});

test('nested ordered and bullet lists retain hierarchy and continuation paragraphs', () => {
  assert.equal(
    sourceContent(
      doc({
        type: 'orderedList',
        attrs: { order: 9 },
        content: [
          item(
            paragraph('Do not perform these actions:'),
            {
              type: 'bulletList',
              content: [item(paragraph('Delete backups.')), item(paragraph('Disable auditing.'))],
            },
            paragraph('The prohibition applies to both actions.'),
          ),
          item(paragraph('Restart the service.')),
        ],
      }),
    ),
    '9. Do not perform these actions:\n\n   - Delete backups.\n   - Disable auditing.\n\n   The prohibition applies to both actions.\n10. Restart the service.',
  );
  assert.equal(
    sourceContent(
      doc({
        type: 'bulletList',
        content: [
          item(paragraph('Example:'), {
            type: 'orderedList',
            attrs: { order: 0 },
            content: [item(paragraph('Initialize.')), item(paragraph('Run.'))],
          }),
        ],
      }),
    ),
    '- Example:\n\n  0. Initialize.\n  1. Run.',
  );
});

test('malformed list numbering and structure are rejected instead of guessed', () => {
  for (const order of [-1, 1.5, '4', null, Number.MAX_SAFE_INTEGER])
    assert.throws(
      () =>
        sourceContent(
          doc({ type: 'orderedList', attrs: { order }, content: [item(paragraph('Run.'))] }),
        ),
      /invalid list numbering/,
    );
  assert.throws(
    () => sourceContent(doc({ type: 'bulletList', content: [paragraph('Missing item')] })),
    /invalid list/,
  );
});

test('quoted and literal list examples remain distinct from executable instructions', () => {
  assert.equal(
    sourceContent(
      doc(
        {
          type: 'blockquote',
          content: [
            paragraph('Old instructions:'),
            { type: 'bulletList', content: [item(paragraph('Do not follow this example.'))] },
          ],
        },
        { type: 'codeBlock', content: [{ type: 'text', text: '```\n1. Literal example' }] },
      ),
    ),
    '> Old instructions:\n> \n> - Do not follow this example.\n\n````\n```\n1. Literal example\n````',
  );
});

test('source text and formatted output have separate limits without accepting empty formatting', () => {
  const code = (text) => ({ type: 'codeBlock', content: [{ type: 'text', text }] });
  assert.equal(sourceContent(doc(code('x'.repeat(4000)))), `\`\`\`\n${'x'.repeat(4000)}\n\`\`\``);
  assert.throws(() => sourceContent(doc(code('x'.repeat(4001)))), /4000/);
  assert.doesNotThrow(() => sourceContent(doc(code('😀'.repeat(4000)))));
  assert.throws(() => sourceContent(doc(code('😀'.repeat(4001)))), /4000/);
  for (const value of [doc({ type: 'rule' }), doc(code('  '))])
    assert.throws(() => sourceContent(value), /4000/);
  let nested = paragraph('x\n'.repeat(2000));
  for (let depth = 0; depth < 10; depth++) nested = { type: 'blockquote', content: [nested] };
  assert.throws(() => sourceContent(doc(nested)), /too much structure.*Read it in Jira/);
});

test('the actual Rovo read handler returns faithful numbered instructions with actor-bound reads', async () => {
  const sdk = forgeContract(
    { body: { id: '1', key: 'TEST', projectTypeKey: 'software', style: 'classic' } },
    {
      body: {
        id: '20',
        key: 'TEST-20',
        fields: {
          project: { id: '1' },
          issuetype: { id: '3' },
          summary: 'Maintenance',
          updated: '1',
          description: numbered,
        },
      },
    },
  );
  sdk.kvs = { entity: () => ({ get: async () => ({ revision: 1, data: { type: '3' } }) }) };
  sdk.appContext = () => ({ environmentType: 'DEVELOPMENT' });
  const result = await registerRovo(sdk)(
    { projectKey: 'TEST', query: '', promptKey: 'TEST-20' },
    { principal: { accountId: 'actor' } },
  );
  assert.equal(result.ok, true);
  assert.equal(result.value.content, numberedText);
  assert.equal(sdk.calls.length, 2);
  assert.ok(sdk.calls.every((call) => call.actor === 'asUser' && (call.method ?? 'GET') === 'GET'));
});
