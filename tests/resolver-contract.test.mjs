import './typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { forgeContract } from './support/forge-contract.mjs';
const { registerResolvers } = await import('../src/integration.ts');

// Every registered resolver validates its context and payload before any Jira or storage access.
const sdk = () => {
  const contract = forgeContract();
  const storage = [];
  return {
    ...contract,
    storage,
    kvs: {
      entity: () => ({
        get: async (key) => {
          storage.push(key);
          return undefined;
        },
      }),
    },
    fieldType: () => 'exact-field',
  };
};
const resolvers = Object.keys(registerResolvers(sdk()));
const revisioned = new Set([
  'save',
  'resolve-save',
  'accept-save',
  'wizard-start',
  'wizard-advance',
  'wizard-stop',
  'settings-resolve',
  'settings-preferences',
]);
const context = {
  accountId: 'actor',
  extension: { project: { id: '1' }, issue: { id: '10' } },
};

test('the resolver set is exactly the supported surface', () => {
  assert.deepEqual(resolvers.sort(), [
    'accept-save',
    'library',
    'load',
    'resolve-save',
    'save',
    'save-status',
    'settings-health',
    'settings-preferences',
    'settings-projects',
    'settings-recover',
    'settings-resolve',
    'setup',
    'wizard-advance',
    'wizard-cancel-interrupted',
    'wizard-catalog',
    'wizard-preview',
    'wizard-start',
    'wizard-status',
    'wizard-stop',
  ]);
});

test('every resolver refuses unknown fields, forged identity and missing context without access', async () => {
  for (const name of resolvers) {
    const cases = [
      ['unknown field', context, { unexpected: 1 }],
      ['forged identity', context, { accountId: 'someone-else' }],
      ['missing account', { extension: context.extension }, {}],
      ['non-object payload', context, 'payload'],
    ];
    if (revisioned.has(name))
      for (const revision of ['1', 1.5, -1, true])
        cases.push([`revision ${JSON.stringify(revision)}`, context, { revision }]);
    for (const [label, ctx, payload] of cases) {
      const s = sdk();
      const result = await registerResolvers(s)[name]({ context: ctx, payload });
      assert.equal(result.ok, false, `${name}: ${label}`);
      assert.equal(typeof result.error, 'string', `${name}: ${label}`);
      assert.equal(s.calls.length, 0, `${name}: ${label} reached Jira`);
      assert.deepEqual(s.storage, [], `${name}: ${label} reached storage`);
    }
  }
});
