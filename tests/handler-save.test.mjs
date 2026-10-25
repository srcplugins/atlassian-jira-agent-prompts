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
const text = (value) => ({ type: 'text', text: value });
const paragraph = (value) => ({ type: 'paragraph', content: [text(value)] });
const heading = (value) => ({ type: 'heading', attrs: { level: 2 }, content: [text(value)] });
const doc = (...content) => ({ type: 'doc', version: 1, content });
const expand = (attrs, ...content) => ({ type: 'expand', attrs, content });
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
const prompt = (id, summary, instructions, extra = {}) => ({
  id,
  key: `TEST-${id}`,
  fields: {
    project: { id: '1' },
    issuetype: { id: '3' },
    summary,
    updated: '1',
    description: doc(paragraph(instructions)),
    ...extra,
  },
});
const source = prompt('20', 'Prompt', 'Instructions');
const original = doc(paragraph('Original'));
// The section the app writes for TEST-20, by hand.
const section = expand(
  { localId: 'agent-prompts-10', title: 'Agent Prompts' },
  heading('TEST-20: Prompt'),
  paragraph('Instructions'),
);
const saved = doc(paragraph('Original'), section);

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
        assert.equal(name, 'agent-prompt-state');
        return { get: async (key) => structuredClone(records.get(key)) };
      },
      transact: () => ({
        set: (key, value, options) => ({
          execute: async () => {
            assert.equal(options.entityName, 'agent-prompt-state');
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
const fields = 'project%2Cissuetype%2Csummary%2Cdescription%2Cupdated%2Cstatus%2Csecurity';
const target = (description, keys) =>
  get(`/rest/api/3/issue/10?fields=${fields}%2C${FIELD}`, issueBody(description, keys));
const read = (id, body) => get(`/rest/api/3/issue/${id}?fields=${fields}`, body);
// Jira answers "not found" both for a deleted work item and for one the user may not see.
const missing = (id) => ({
  expect: { method: 'GET', path: `/rest/api/3/issue/${id}?fields=${fields}` },
  status: 404,
  body: { errorMessages: ['PRIVATE'] },
});
const put = { expect: { method: 'PUT', path: '/rest/api/3/issue/10' }, status: 204 };

function harness(...responses) {
  const contract = forgeContract(...responses);
  const kv = store();
  const sdk = {
    ...contract,
    ...kv,
    fieldType: () => 'exact-field',
    appContext: () => ({ environmentType: 'DEVELOPMENT' }),
  };
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
const permission = get('/rest/api/3/mypermissions?projectId=1&issueId=10&permissions=EDIT_ISSUES', {
  permissions: { EDIT_ISSUES: { havePermission: true } },
});
// A save reads the work item, checks Edit, reads each prompt, then reads the work item again and
// writes over that.
const saveReads = (description, keys, sources) => [
  fieldList,
  target(description, keys),
  permission,
  ...sources,
  target(description, keys),
];
const saveReadsOf = (description = original, keys = []) =>
  saveReads(description, keys, [read('20', source)]);

test('a save through the resolver claims, writes once and settles with conditional storage', async () => {
  const h = harness(...loadResponses(), ...saveReadsOf(), put);
  const loaded = await h.resolvers.load({ context, payload: {} });
  assert.equal(loaded.ok, true);
  const result = await h.resolvers.save({
    context,
    payload: { ids: ['20'], revision: loaded.value.revision },
  });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.value, { revision: 3, ids: ['20'] });
  const write = h.contract.calls.find((call) => call.method === 'PUT');
  assert.equal(write.actor, 'asUser');
  assert.deepEqual(JSON.parse(write.body), {
    fields: { description: saved, [FIELD]: ['TEST-20'] },
  });
  // Claim (absent), submit, then settle — each conditional on the exact previous revision.
  assert.deepEqual(h.kv.conditions, [
    ['issue-10', 'missing'],
    ['issue-10', ['equal', 1]],
    ['issue-10', ['equal', 2]],
  ]);
  assert.deepEqual(h.kv.records.get('issue-10'), {
    revision: 3,
    data: { ids: ['20'], keys: ['TEST-20'] },
  });
  h.contract.assertDrained();
});

// Owner decision 2026-10-22: whatever anyone wrote in the description, every Agent Prompts block is
// removed and one section is written from the linked prompts. Sync never refuses for it.
const other = (...content) => expand({ title: 'Agent Prompts' }, ...content);
const syncCases = [
  [
    'an edited section',
    doc(
      paragraph('Original'),
      expand(
        { localId: 'agent-prompts-10', title: 'Agent Prompts' },
        heading('TEST-20: Prompt'),
        paragraph('Instructions, edited by hand'),
        paragraph('A note typed into the section'),
      ),
    ),
    saved,
  ],
  [
    'a section moved into a panel',
    doc(paragraph('Original'), { type: 'panel', attrs: { panelType: 'info' }, content: [section] }),
    doc(paragraph('Original'), section, {
      type: 'panel',
      attrs: { panelType: 'info' },
      content: [{ type: 'paragraph' }],
    }),
  ],
  [
    'a duplicated section',
    doc(paragraph('Original'), section, paragraph('More'), section),
    doc(paragraph('Original'), section, paragraph('More')),
  ],
  ['a deleted section', original, saved],
  [
    'a section copied from another work item',
    doc(
      paragraph('Original'),
      expand(
        { localId: 'agent-prompts-99', title: 'Agent Prompts' },
        heading('TEST-30: Elsewhere'),
        paragraph('Not linked here'),
      ),
    ),
    saved,
  ],
  [
    'a whole-description rewrite',
    doc(paragraph('Rewritten from scratch'), paragraph('Second line')),
    doc(paragraph('Rewritten from scratch'), paragraph('Second line'), section),
  ],
  [
    '100 Agent Prompts blocks',
    doc(
      paragraph('Original'),
      ...Array.from({ length: 100 }, (_, i) => other(paragraph(`Copy ${i}`))),
      paragraph('After'),
    ),
    doc(paragraph('Original'), section, paragraph('After')),
  ],
  [
    'fake keys in the section and the field',
    doc(paragraph('Original'), other(heading('FAKE-1: Made up'), paragraph('Fake'))),
    saved,
    ['FAKE-1', 'FAKE-2'],
  ],
  [
    'a prompt added to the section by hand',
    doc(
      paragraph('Original'),
      expand(
        { localId: 'agent-prompts-10', title: 'Agent Prompts' },
        heading('TEST-20: Prompt'),
        paragraph('Instructions'),
        heading('TEST-21: Checklist'),
        paragraph('Check errors.'),
      ),
    ),
    saved,
    ['TEST-20', 'TEST-21'],
  ],
  [
    'a section nested in a table cell',
    doc(paragraph('Original'), {
      type: 'table',
      content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [section] }] }],
    }),
    doc(paragraph('Original'), section, {
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [{ type: 'tableCell', content: [{ type: 'paragraph' }] }],
        },
      ],
    }),
  ],
];

for (const [name, description, expected, keys = ['TEST-20']] of syncCases)
  test(`Sync through the resolver rewrites ${name} from the linked prompts`, async () => {
    const h = harness(...saveReadsOf(description, keys), put);
    h.kv.records.set('issue-10', { revision: 5, data: { ids: ['20'], keys: ['TEST-20'] } });
    const result = await h.resolvers.save({ context, payload: { sync: true } });
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.value, { revision: 8, ids: ['20'] });
    assert.deepEqual(JSON.parse(h.contract.calls.at(-1).body), {
      fields: { description: expected, [FIELD]: ['TEST-20'] },
    });
    assert.deepEqual(h.kv.records.get('issue-10'), {
      revision: 8,
      data: { ids: ['20'], keys: ['TEST-20'] },
    });
    h.contract.assertDrained();
  });

test('Sync of a section already exactly right, wherever it is, writes nothing', async () => {
  for (const description of [saved, doc(section, paragraph('Original'))]) {
    const h = harness(...saveReadsOf(description, ['TEST-20']));
    h.kv.records.set('issue-10', { revision: 5, data: { ids: ['20'], keys: ['TEST-20'] } });
    const result = await h.resolvers.save({ context, payload: { sync: true } });
    assert.deepEqual(result, { ok: true, value: { revision: 5, ids: ['20'] } });
    assert.deepEqual(h.kv.conditions, []);
    h.contract.assertDrained();
  }
});

test('Sync drops a deleted linked prompt and names it by the key it had', async () => {
  const before = doc(
    paragraph('Original'),
    expand(
      { localId: 'agent-prompts-10', title: 'Agent Prompts' },
      heading('TEST-20: Prompt'),
      paragraph('Instructions'),
      heading('TEST-21: Checklist'),
      paragraph('Check errors.'),
    ),
  );
  const h = harness(
    ...saveReads(before, ['TEST-20', 'TEST-21'], [read('20', source), missing('21')]),
    put,
  );
  h.kv.records.set('issue-10', {
    revision: 5,
    data: { ids: ['20', '21'], keys: ['TEST-20', 'TEST-21'] },
  });
  const result = await h.resolvers.save({ context, payload: { sync: true } });
  assert.deepEqual(result, {
    ok: true,
    value: { revision: 8, ids: ['20'], dropped: ['TEST-21'] },
  });
  assert.deepEqual(JSON.parse(h.contract.calls.at(-1).body), {
    fields: { description: saved, [FIELD]: ['TEST-20'] },
  });
  h.contract.assertDrained();
});

test('a Save naming a prompt that never existed drops it and saves the rest', async () => {
  const h = harness(
    ...loadResponses(),
    ...saveReads(original, [], [read('20', source), missing('99')]),
    put,
  );
  const loaded = (await h.resolvers.load({ context, payload: {} })).value;
  const result = await h.resolvers.save({
    context,
    payload: { ids: ['20', '99'], revision: loaded.revision },
  });
  assert.deepEqual(result, {
    ok: true,
    value: { revision: 3, ids: ['20'], dropped: ['the prompt with ID 99'] },
  });
  assert.deepEqual(JSON.parse(h.contract.calls.at(-1).body), {
    fields: { description: saved, [FIELD]: ['TEST-20'] },
  });
  h.contract.assertDrained();
});

test('Sync with every linked prompt gone removes the section and clears the field', async () => {
  const h = harness(...saveReads(saved, ['TEST-20'], [missing('20')]), put);
  h.kv.records.set('issue-10', { revision: 5, data: { ids: ['20'], keys: ['TEST-20'] } });
  const result = await h.resolvers.save({ context, payload: { sync: true } });
  assert.deepEqual(result, { ok: true, value: { revision: 8, ids: [], dropped: ['TEST-20'] } });
  assert.deepEqual(JSON.parse(h.contract.calls.at(-1).body), {
    fields: { description: original, [FIELD]: [] },
  });
  assert.deepEqual(h.kv.records.get('issue-10').data, { ids: [], keys: [] });
  h.contract.assertDrained();
});

test('a linked prompt the user may not see stops Sync with a permission message and no write', async () => {
  const secured = prompt('21', 'Checklist', 'Check errors.', { security: { id: '10000' } });
  // The prompt had a security level when it was copied, so "not found" means it is hidden.
  const first = harness(...saveReads(original, [], [read('20', source), read('21', secured)]), put);
  first.kv.records.set('issue-10', { revision: 5, data: { ids: [], keys: [] } });
  const loaded = { revision: 5 };
  const saving = await first.resolvers.save({
    context,
    payload: { ids: ['20', '21'], revision: loaded.revision },
  });
  assert.equal(saving.ok, true, saving.error);
  const record = first.kv.records.get('issue-10');
  assert.deepEqual(record.data, {
    ids: ['20', '21'],
    keys: ['TEST-20', 'TEST-21'],
    secured: ['21'],
  });
  // The save stops before it reads the work item a second time.
  const h = harness(
    fieldList,
    target(saved, ['TEST-20', 'TEST-21']),
    permission,
    read('20', source),
    missing('21'),
  );
  h.kv.records.set('issue-10', record);
  const result = await h.resolvers.save({ context, payload: { sync: true } });
  assert.deepEqual(result, {
    ok: false,
    error:
      "Nothing was synced: you can't see TEST-21 in Jira. A Jira administrator manages who can see it.",
  });
  assert.equal(
    h.contract.calls.some((call) => call.method === 'PUT'),
    false,
  );
  assert.deepEqual(h.kv.conditions, []);
  assert.deepEqual(h.kv.records.get('issue-10'), record);
  h.contract.assertDrained();
});

test('a documented rejection through the resolver restores the claim and never repeats the write', async () => {
  for (const [status, message] of [
    [409, /HTTP 409.*Review your selection/],
    [429, /limiting requests/],
    [400, /Agent Prompts field is available/],
  ]) {
    const h = harness(...loadResponses(), ...saveReadsOf(), {
      expect: { method: 'PUT', path: '/rest/api/3/issue/10' },
      status,
      body: { errorMessages: ['PRIVATE'] },
    });
    const loaded = (await h.resolvers.load({ context, payload: {} })).value;
    const result = await h.resolvers.save({
      context,
      payload: { ids: ['20'], revision: loaded.revision },
    });
    assert.equal(result.ok, false);
    assert.match(result.error, message);
    assert.doesNotMatch(result.error, /PRIVATE/);
    assert.equal(h.contract.calls.filter((call) => call.method === 'PUT').length, 1);
    // Restored to the pre-claim data at the next revision; nothing pending.
    const record = h.kv.records.get('issue-10');
    assert.deepEqual(record.data, { ids: [] });
    assert.deepEqual(h.kv.conditions.at(-1), ['issue-10', ['equal', 2]]);
    h.contract.assertDrained();
  }
});

test('an uncertain PUT through the resolver leaves the submitted claim and reads nothing further', async () => {
  const h = harness(...loadResponses(), ...saveReadsOf(), {
    expect: { method: 'PUT', path: '/rest/api/3/issue/10' },
    status: 503,
  });
  const loaded = (await h.resolvers.load({ context, payload: {} })).value;
  const result = await h.resolvers.save({
    context,
    payload: { ids: ['20'], revision: loaded.revision },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /could not be confirmed/);
  const pending = h.kv.records.get('issue-10').data.pending;
  assert.equal(pending.phase, 'submitted');
  assert.deepEqual(pending.keys, ['TEST-20']);
  h.contract.assertDrained();
});

test('save input outside the contract is refused before any Jira or storage access', async () => {
  for (const payload of [
    { ids: ['1', '2', '3', '4', '5', '6'], revision: 0 },
    { ids: ['20', '20'], revision: 0 },
    { ids: ['x'], revision: 0 },
    { ids: ['20'], revision: 1.5 },
    { ids: ['20'] },
    { sync: 'yes' },
    { ids: ['20'], revision: 0, fingerprint: 'f' },
    { ids: ['20'], revision: 0, accountId: 'other' },
  ]) {
    const h = harness();
    const result = await h.resolvers.save({ context, payload });
    assert.equal(result.ok, false, JSON.stringify(payload));
    assert.equal(h.contract.calls.length, 0);
    assert.equal(h.kv.conditions.length, 0);
  }
  // Five distinct prompts is within the limit and reaches Jira.
  const five = harness();
  const result = await five.resolvers.save({
    context,
    payload: { ids: ['1', '2', '3', '4', '5'], revision: 0 },
  });
  assert.equal(result.ok, false);
  assert.equal(five.contract.calls[0].path, '/rest/api/3/field');
});
