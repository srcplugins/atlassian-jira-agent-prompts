import './support/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { createService, UserError } = await import('../src/service.ts');
const doc = (text) => ({
  type: 'doc',
  version: 1,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});
const context = { accountId: 'actor', projectId: '1', issueId: '10' };
function fixture() {
  let stored;
  let writes = 0;
  const target = {
    id: '10',
    key: 'TEST-10',
    fields: {
      project: { id: '1' },
      issuetype: { id: '2' },
      summary: 'Work',
      updated: '1',
      description: doc('Keep this'),
    },
  };
  const source = {
    id: '20',
    key: 'TEST-20',
    fields: {
      project: { id: '1' },
      issuetype: { id: '3' },
      summary: 'Review',
      updated: '1',
      description: doc('Check errors'),
    },
  };
  const ports = {
    refreshAfterSave: async () => false,
    retainedTypes: async () => [],
    config: async () => '3',
    field: async () => 'customfield_1',
    allowed: async () => {},
    search: async () => ({
      prompts: [{ id: '20', key: source.key, name: source.fields.summary }],
      incomplete: false,
    }),
    issue: async (id) => structuredClone(id === '10' ? target : source),
    get: async () => structuredClone(stored),
    cas: async (_id, revision, data) => {
      if ((stored?.revision ?? 0) !== revision) throw Error('conflict');
      stored = { revision: revision + 1, data: structuredClone(data) };
    },
    update: async (_id, fields) => {
      writes++;
      Object.assign(target.fields, structuredClone(fields));
      target.fields.updated += '1';
    },
  };
  return { ports, service: createService(ports), target, writes: () => writes };
}
function failDiscovery(f) {
  f.ports.search = async () => {
    throw new UserError('Jira request failed (HTTP 429).');
  };
}

test('failed discovery retains saved selection metadata and permits explicit removal', async () => {
  const f = fixture();
  await f.service.save(context, { ...(await f.service.load(context)), ids: ['20'] });
  failDiscovery(f);
  const current = await f.service.load(context);
  assert.equal(current.incomplete, true);
  assert.match(current.searchError, /Could not load prompt suggestions/);
  assert.equal(current.nextCursor, undefined);
  assert.deepEqual(current.ids, ['20']);
  assert.deepEqual(current.prompts, [{ id: '20', key: 'TEST-20', name: 'Review' }]);
  assert.equal(f.writes(), 1);
  await f.service.save(context, { ...current, ids: [] });
  assert.equal(f.writes(), 2);
  assert.deepEqual(f.target.fields.customfield_1, []);
  assert.deepEqual(f.target.fields.description, doc('Keep this'));
});

test('failed discovery and inaccessible selected source still permit removal without revealing metadata', async () => {
  const f = fixture();
  await f.service.save(context, { ...(await f.service.load(context)), ids: ['20'] });
  failDiscovery(f);
  const read = f.ports.issue;
  f.ports.issue = async (id) => {
    if (id === '20') throw Error('Denied');
    return read(id);
  };
  const current = await f.service.load(context);
  assert.deepEqual(current.ids, ['20']);
  assert.deepEqual(current.prompts, []);
  assert.equal(current.incomplete, true);
  assert.ok(current.searchError);
  await f.service.save(context, { ...current, ids: [] });
  assert.deepEqual(f.target.fields.description, doc('Keep this'));
});

test('a committed write with a lost response can be reconciled while discovery is unavailable', async () => {
  const f = fixture();
  const loaded = await f.service.load(context);
  const update = f.ports.update;
  f.ports.update = async (...args) => {
    await update(...args);
    throw Error('Lost response');
  };
  await assert.rejects(
    f.service.save(context, { ...loaded, ids: ['20'] }),
    /could not be confirmed/,
  );
  failDiscovery(f);
  f.ports.retainedTypes = async () => {
    throw Error('Retained types unavailable');
  };
  f.ports.refreshAfterSave = async () => {
    throw Error('Preference unavailable');
  };
  const recovered = await f.service.load(context);
  assert.deepEqual(recovered.ids, ['20']);
  assert.ok(recovered.revision > loaded.revision);
  assert.ok(recovered.searchError);
  assert.match(recovered.loadWarning, /Previous prompt types.*reload preference/);
  assert.equal(recovered.refreshAfterSave, false);
  assert.equal(f.writes(), 1);
});

test('auxiliary settings failures preserve saved removal while retained-source authorization fails closed', async () => {
  for (const mode of ['retained', 'refresh', 'both']) {
    const f = fixture();
    await f.service.save(context, { ...(await f.service.load(context)), ids: ['20'] });
    let retainedReads = 0;
    if (mode !== 'refresh') {
      f.ports.config = async () => '4';
      f.ports.search = async () => ({ prompts: [], incomplete: false });
      f.ports.retainedTypes = async () => {
        retainedReads++;
        throw Error('Retained types unavailable');
      };
    }
    if (mode !== 'retained')
      f.ports.refreshAfterSave = async () => {
        throw Error('Preference unavailable');
      };
    const current = await f.service.load(context);
    assert.deepEqual(current.ids, ['20']);
    assert.ok(current.loadWarning);
    if (mode !== 'refresh') {
      assert.deepEqual(current.prompts, []);
      assert.match(current.loadWarning, /Previous prompt types/);
      await assert.rejects(f.service.save(context, current), /Retained types unavailable/);
      assert.equal(f.writes(), 1);
    }
    if (mode !== 'retained') {
      assert.equal(current.refreshAfterSave, false);
      assert.match(current.loadWarning, /Reload the work item manually/);
    }
    const readsBeforeRemoval = retainedReads;
    await f.service.save(context, { ...current, ids: [] });
    assert.equal(retainedReads, readsBeforeRemoval);
    assert.equal(f.writes(), 2);
    assert.deepEqual(f.target.fields.customfield_1, []);
    assert.deepEqual(f.target.fields.description, doc('Keep this'));
  }
});

test('current-type selections do not depend on previous-type authorization reads', async () => {
  const f = fixture();
  let retainedReads = 0;
  f.ports.retainedTypes = async () => {
    retainedReads++;
    throw Error('Retained types unavailable');
  };
  const loaded = await f.service.load(context);
  assert.equal(retainedReads, 1);
  await f.service.save(context, { ...loaded, ids: ['20'] });
  assert.equal(retainedReads, 1);
  assert.equal(f.writes(), 1);
  assert.deepEqual(f.target.fields.customfield_1, ['TEST-20']);
});
