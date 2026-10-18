import './support/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { forgeContract } from './support/forge-contract.mjs';
const { registerResolvers } = await import('../src/integration.ts');
const { hash } = await import('../src/service.ts');

// The full save path through the registered resolver: real adapters, the fail-closed SDK double
// with path matching, and a conditional KVS emulator. Expected bodies are written out by hand.
const FIELD = 'customfield_10001';
const context = { accountId: 'user', extension: { project: { id: '1' }, issue: { id: '10' } } };
const paragraph = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const doc = (...content) => ({ type: 'doc', version: 1, content });
const issueBody = (description, keys = []) => ({
  id: '10',
  key: 'TEST-10',
  fields: {
    project: { id: '1' },
    issuetype: { id: '2' },
    summary: 'Work',
    updated: `u-${hash([description, keys]).slice(0, 8)}`,
    description,
    [FIELD]: keys,
  },
});
const source = {
  id: '20',
  key: 'TEST-20',
  fields: {
    project: { id: '1' },
    issuetype: { id: '3' },
    summary: 'Prompt',
    updated: '1',
    description: doc(paragraph('Instructions')),
  },
};
const original = doc(paragraph('Original'));
const saved = doc(paragraph('Original'), {
  type: 'expand',
  attrs: { localId: 'npl-10', title: 'Agent Prompts' },
  content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'TEST-20: Prompt' }] },
    paragraph('Instructions'),
  ],
});

function store() {
  const records = new Map([['config-1', { revision: 1, data: { type: '3' } }]]);
  const conditions = [];
  class Filter {
    and(name, condition) {
      this.condition = [name, condition];
      return this;
    }
  }
  return {
    records,
    conditions,
    Filter,
    FilterConditions: { notExists: () => 'missing', equalTo: (value) => ['equal', value] },
    kvs: {
      entity: (name) => {
        assert.equal(name, 'native-prompt-state');
        return { get: async (key) => structuredClone(records.get(key)) };
      },
      transact: () => ({
        set: (key, value, options) => ({
          execute: async () => {
            assert.equal(options.entityName, 'native-prompt-state');
            const [, condition] = options.conditions.condition;
            conditions.push([key, condition]);
            const current = records.get(key);
            if (condition === 'missing' ? current : current?.revision !== condition[1])
              throw Error('conditional write failed');
            records.set(key, structuredClone(value));
          },
        }),
      }),
    },
  };
}

const get = (path, body) => ({ expect: { method: 'GET', path }, body });
const fieldList = get('/rest/api/3/field', [{ id: FIELD, schema: { custom: 'exact-field' } }]);
const target = (description, keys) =>
  get(
    `/rest/api/3/issue/10?fields=project%2Cissuetype%2Csummary%2Cdescription%2Cupdated%2Cstatus%2C${FIELD}`,
    issueBody(description, keys),
  );

function harness(...responses) {
  const contract = forgeContract(...responses);
  const kv = store();
  const sdk = { ...contract, ...kv, fieldType: () => 'exact-field' };
  return { contract, kv, resolvers: registerResolvers(sdk) };
}

// The read half of the protocol, through the real load resolver.
const loadResponses = () => [
  fieldList,
  target(original, []),
  {
    expect: { method: 'POST', path: '/rest/api/3/search/jql' },
    body: { issues: [], isLast: true },
  },
];
const saveReads = (description = original, keys = []) => [
  fieldList,
  target(description, keys),
  get('/rest/api/3/mypermissions?projectId=1&issueId=10&permissions=EDIT_ISSUES', {
    permissions: { EDIT_ISSUES: { havePermission: true } },
  }),
  get(
    '/rest/api/3/issue/20?fields=project%2Cissuetype%2Csummary%2Cdescription%2Cupdated%2Cstatus',
    source,
  ),
  target(description, keys),
];

test('a save through the resolver claims, writes once, observes and settles with conditional storage', async () => {
  const h = harness(
    ...loadResponses(),
    ...saveReads(),
    { expect: { method: 'PUT', path: '/rest/api/3/issue/10' }, status: 204 },
    target(saved, ['TEST-20']),
  );
  const loaded = await h.resolvers.load({ context, payload: {} });
  assert.equal(loaded.ok, true);
  const result = await h.resolvers.save({
    context,
    payload: {
      ids: ['20'],
      revision: loaded.value.revision,
      fingerprint: loaded.value.fingerprint,
    },
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.value.revision, 3);
  const put = h.contract.calls.find((call) => call.method === 'PUT');
  assert.equal(put.actor, 'asUser');
  assert.deepEqual(JSON.parse(put.body), { fields: { description: saved, [FIELD]: ['TEST-20'] } });
  // Claim (absent), submit, then settle — each conditional on the exact previous revision.
  assert.deepEqual(h.kv.conditions, [
    ['issue-10', 'missing'],
    ['issue-10', ['equal', 1]],
    ['issue-10', ['equal', 2]],
  ]);
  const record = h.kv.records.get('issue-10');
  assert.equal(record.revision, 3);
  assert.deepEqual(record.data.ids, ['20']);
  assert.equal(record.data.pending, undefined);
  h.contract.assertDrained();
});

test('a documented rejection through the resolver restores the claim and never repeats the write', async () => {
  for (const [status, message] of [
    [409, /HTTP 409.*Review your selection/],
    [429, /limiting requests/],
    [400, /Agent Prompts field is available/],
  ]) {
    const h = harness(...loadResponses(), ...saveReads(), {
      expect: { method: 'PUT', path: '/rest/api/3/issue/10' },
      status,
      body: { errorMessages: ['PRIVATE'] },
    });
    const loaded = (await h.resolvers.load({ context, payload: {} })).value;
    const result = await h.resolvers.save({
      context,
      payload: { ids: ['20'], revision: loaded.revision, fingerprint: loaded.fingerprint },
    });
    assert.equal(result.ok, false);
    assert.match(result.error, message);
    assert.doesNotMatch(result.error, /PRIVATE/);
    assert.equal(h.contract.calls.filter((call) => call.method === 'PUT').length, 1);
    // Restored to the pre-claim data at the next revision; nothing pending.
    const record = h.kv.records.get('issue-10');
    assert.deepEqual(record.data, { ids: [], managed: null });
    assert.deepEqual(h.kv.conditions.at(-1), ['issue-10', ['equal', 2]]);
    h.contract.assertDrained();
  }
});

test('an uncertain PUT through the resolver leaves the submitted claim and reads nothing further', async () => {
  const h = harness(...loadResponses(), ...saveReads(), {
    expect: { method: 'PUT', path: '/rest/api/3/issue/10' },
    status: 503,
  });
  const loaded = (await h.resolvers.load({ context, payload: {} })).value;
  const result = await h.resolvers.save({
    context,
    payload: { ids: ['20'], revision: loaded.revision, fingerprint: loaded.fingerprint },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /could not be confirmed/);
  const pending = h.kv.records.get('issue-10').data.pending;
  assert.equal(pending.phase, 'submitted');
  assert.deepEqual(pending.keys, ['TEST-20']);
  assert.equal(typeof pending.shape, 'string');
  h.contract.assertDrained();
});

test('save input outside the contract is refused before any Jira or storage access', async () => {
  for (const payload of [
    { ids: ['1', '2', '3', '4', '5', '6'], revision: 0, fingerprint: 'f' },
    { ids: ['20', '20'], revision: 0, fingerprint: 'f' },
    { ids: ['x'], revision: 0, fingerprint: 'f' },
    { ids: ['20'], revision: 1.5, fingerprint: 'f' },
    { ids: ['20'], revision: 0, fingerprint: 1 },
    { ids: ['20'], revision: 0, fingerprint: 'f', accountId: 'other' },
  ]) {
    const h = harness();
    const result = await h.resolvers.save({ context, payload });
    assert.equal(result.ok, false);
    assert.equal(h.contract.calls.length, 0);
    assert.equal(h.kv.conditions.length, 0);
  }
  // Five distinct prompts is within the limit and reaches Jira.
  const five = harness();
  const result = await five.resolvers.save({
    context,
    payload: { ids: ['1', '2', '3', '4', '5'], revision: 0, fingerprint: 'f' },
  });
  assert.equal(result.ok, false);
  assert.equal(five.contract.calls[0].path, '/rest/api/3/field');
});
