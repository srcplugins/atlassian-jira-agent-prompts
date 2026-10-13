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
  'configuration-start',
  'configuration-advance',
  'configuration-stop',
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
    'configuration-advance',
    'configuration-cancel-interrupted',
    'configuration-catalog',
    'configuration-preview',
    'configuration-start',
    'configuration-status',
    'configuration-stop',
    'load',
    'resolve-save',
    'save',
    'save-status',
    'search',
    'settings-health',
    'settings-preferences',
    'settings-projects',
    'settings-recover',
    'settings-resolve',
    'setup',
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

// A valid request for each resolver, so it gets past validation to its first Jira or storage
// access.
const valid = {
  setup: {},
  search: { query: '' },
  load: {},
  save: { ids: [], revision: 0, fingerprint: 'x' },
  'save-status': {},
  'resolve-save': { revision: 0, fingerprint: 'x', acknowledged: true },
  'accept-save': { revision: 0, fingerprint: 'x', acknowledged: true },
  'settings-projects': {},
  'settings-health': { projectId: '1' },
  'settings-recover': { projectId: '1' },
  'settings-resolve': { projectId: '1', revision: 0 },
  'settings-preferences': { projectId: '1', revision: 0, refreshAfterSave: true },
  'configuration-catalog': {},
  'configuration-status': {},
  'configuration-cancel-interrupted': {},
  'configuration-preview': { projectId: '1', type: '3' },
  'configuration-start': {
    type: '3',
    entries: [{ projectId: '1', fingerprint: 'x' }],
    revision: 0,
  },
  'configuration-advance': { id: 'x', revision: 0 },
  'configuration-stop': { id: 'x', revision: 0 },
};

test('an unexpected error in any resolver returns the generic message and logs one fixed line', async (t) => {
  assert.deepEqual(Object.keys(valid).sort(), [...resolvers].sort());
  const logged = [];
  t.mock.method(console, 'error', (line) => logged.push(line));
  const fail = (where) => {
    throw new TypeError(`private ${where} detail`);
  };
  for (const name of resolvers) {
    logged.length = 0;
    // A defect in app code, not an outage: building a request path throws, and a stored record
    // throws as soon as the app reads it. (A failing storage call itself is an outage and is
    // reported as such.)
    const record = new Proxy(
      {},
      { get: (_, key) => (key === 'then' ? undefined : fail('record')) },
    );
    const s = {
      ...sdk(),
      route: () => fail('route'),
      kvs: { entity: () => ({ get: async () => record }), transact: () => fail('storage') },
      fieldType: () => fail('field'),
    };
    const result = await registerResolvers(s)[name]({ context, payload: valid[name] });
    assert.deepEqual(
      result,
      { ok: false, error: 'Request could not be completed. Refresh and check your Jira access.' },
      name,
    );
    assert.deepEqual(logged, ['{"event":"resolver_failed","category":"unexpected"}'], name);
  }
});
