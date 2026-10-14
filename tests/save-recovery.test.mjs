import './support/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { createService, hash } = await import('../src/service.ts');
const c = { accountId: 'user', projectId: '1', issueId: '10' };
const doc = (text) => ({
  type: 'doc',
  version: 1,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});
function fixture() {
  let stored,
    transactions = 0,
    writes = 0;
  const target = {
    id: '10',
    key: 'TEST-10',
    fields: {
      project: { id: '1' },
      issuetype: { id: '2' },
      summary: 'Work',
      updated: '1',
      description: doc('Original'),
    },
  };
  const source = {
    id: '20',
    key: 'TEST-20',
    fields: {
      project: { id: '1' },
      issuetype: { id: '3' },
      summary: 'Prompt',
      updated: '1',
      description: doc('Instructions'),
    },
  };
  const p = {
    refreshAfterSave: async () => false,
    retainedTypes: async () => [],
    config: async () => '3',
    field: async () => 'customfield_1',
    allowed: async () => {},
    search: async () => ({
      prompts: [{ id: '20', key: 'TEST-20', name: 'Prompt' }],
      incomplete: false,
    }),
    issue: async (id) => structuredClone(id === '10' ? target : source),
    get: async () => structuredClone(stored),
    cas: async (_id, revision, data) => {
      assert.equal(stored?.revision ?? 0, revision, 'conditional revision must match');
      stored = { revision: revision + 1, data: structuredClone(data) };
      transactions++;
    },
    update: async (_id, fields) => {
      writes++;
      Object.assign(target.fields, structuredClone(fields));
      target.fields.updated += '1';
    },
  };
  return {
    p,
    service: createService(p),
    target,
    source,
    stored: () => stored,
    writes: () => writes,
    transactions: () => transactions,
  };
}
async function pending(f, { phase = 'submitted', age = 120001 } = {}) {
  await f.p.cas('10', f.stored()?.revision ?? 0, {
    ids: [],
    managed: null,
    pending: {
      before: hash([f.target.fields.description, []]),
      after: 'unobserved',
      ids: ['20'],
      managed: null,
      keys: ['TEST-20'],
      shape: 'unobserved',
      beforeField: hash(['field', []]),
      beforeBlock: hash([]),
      afterBlock: 'unobserved',
      attemptId: 'original',
      phase,
      started: Date.now() - age,
    },
  });
}
test('lost claim and transition responses release only the never-submitted attempt', async () => {
  for (const failAt of [1, 2]) {
    const f = fixture(),
      cas = f.p.cas;
    f.p.cas = async (...args) => {
      await cas(...args);
      if (f.transactions() === failAt) throw Error('Lost committed response');
    };
    await assert.rejects(
      f.service.save(c, { ...(await f.service.load(c)), ids: ['20'] }),
      /not sent to Jira/,
    );
    assert.equal(f.writes(), 0);
    assert.equal(f.stored().data.pending, undefined);
    await f.service.save(c, { ...(await f.service.load(c)), ids: ['20'] });
    assert.equal(f.writes(), 1);
  }
});
test('prepared-claim recovery fences a paused original sender before any Jira write', async () => {
  const f = fixture();
  await pending(f, { phase: 'prepared', age: 0 });
  const old = structuredClone(f.stored());
  assert.equal((await f.service.saveStatus(c)).pending, false);
  await assert.rejects(
    f.p.cas('10', old.revision, {
      ...old.data,
      pending: { ...old.data.pending, phase: 'submitted' },
    }),
  );
  assert.equal(f.writes(), 0);
  assert.deepEqual((await f.service.load(c)).ids, []);
});
test('a losing concurrent claimant cannot release an identical winning claim', async () => {
  const f = fixture(),
    cas = f.p.cas;
  const loaded = await f.service.load(c);
  let winner;
  f.p.cas = async (id, revision, data) => {
    if (revision === 0) {
      winner = {
        ...data,
        pending: { ...data.pending, attemptId: 'another-attempt', phase: 'submitted' },
      };
      await cas(id, revision, winner);
      throw Error('CAS conflict');
    }
    return cas(id, revision, data);
  };
  await assert.rejects(f.service.save(c, { ...loaded, ids: ['20'] }), /not sent to Jira/);
  assert.deepEqual(f.stored().data, winner);
  assert.equal(f.writes(), 0);
});
test('abandoned submitted writes require admin, Edit, explicit acknowledgment, time and unchanged state', async () => {
  for (const mode of ['admin', 'edit', 'ack', 'time', 'changed', 'stale', 'ok']) {
    const f = fixture();
    await pending(f, { age: mode === 'time' ? 0 : 120001 });
    const status = await f.service.saveStatus(c);
    const original = structuredClone(f.target);
    f.p.allowed = async (_project, permission) => {
      if (
        (mode === 'admin' && permission === 'ADMINISTER') ||
        (mode === 'edit' && permission === 'EDIT_ISSUES')
      )
        throw Error('Denied');
    };
    if (mode === 'changed') f.target.fields.description = doc('Native edit');
    const input = {
      revision: status.revision,
      fingerprint: status.fingerprint,
      acknowledged: mode !== 'ack',
    };
    if (mode === 'stale') input.revision--;
    if (mode === 'ok') {
      await f.service.resolveSave(c, input);
      assert.equal(f.stored().data.pending, undefined);
      assert.deepEqual(f.target, original);
      await f.service.save(c, { ...(await f.service.load(c)), ids: ['20'] });
      assert.equal(f.writes(), 1);
    } else {
      await assert.rejects(f.service.resolveSave(c, input));
      assert.ok(f.stored().data.pending);
      assert.equal(f.writes(), 0);
    }
  }
});
test('failed administrator authorization exposes no manual release capability', async () => {
  const f = fixture();
  await pending(f);
  f.p.allowed = async () => {
    throw Error('Permission service unavailable');
  };
  const value = await f.service.saveStatus(c);
  assert.equal(value.administrator, false);
  assert.equal(value.keys, undefined);
});
test('submitted uncertainty is never cleared by an ordinary load or retried automatically', async () => {
  const f = fixture();
  const baseline = structuredClone(f.target);
  f.p.update = async () => {
    throw Error('Ambiguous transport');
  };
  await assert.rejects(
    f.service.save(c, { ...(await f.service.load(c)), ids: ['20'] }),
    /could not be confirmed/,
  );
  for (let i = 0; i < 3; i++)
    await assert.rejects(f.service.load(c), /previous save could not be verified/);
  assert.equal(f.stored().data.pending.phase, 'submitted');
  assert.deepEqual(f.target, baseline);
});
test('lost response during Sync releases the unsent claim and permits later removal', async () => {
  const f = fixture();
  await f.service.save(c, { ...(await f.service.load(c)), ids: ['20'] });
  f.source.fields.description = doc('Changed instructions');
  const loaded = await f.service.load(c),
    cas = f.p.cas;
  let fail = true;
  f.p.cas = async (...args) => {
    await cas(...args);
    if (fail) {
      fail = false;
      throw Error('Lost response');
    }
  };
  await assert.rejects(f.service.save(c, loaded), /not sent to Jira/);
  assert.equal(f.writes(), 1);
  await f.service.save(c, { ...(await f.service.load(c)), ids: [] });
  assert.equal(f.writes(), 2);
  assert.deepEqual(f.target.fields.description, doc('Original'));
});
test('a read fences a paused sender and its late cleanup preserves a replacement submitted writer', async () => {
  const f = fixture(),
    cas = f.p.cas,
    update = f.p.update;
  let preparedEntered, releasePrepared, updateEntered, releaseUpdate;
  const preparedSeen = new Promise((resolve) => (preparedEntered = resolve));
  const preparedWait = new Promise((resolve) => (releasePrepared = resolve));
  const updateSeen = new Promise((resolve) => (updateEntered = resolve));
  const updateWait = new Promise((resolve) => (releaseUpdate = resolve));
  f.p.cas = async (id, revision, data) => {
    await cas(id, revision, data);
    if (revision === 0) {
      preparedEntered();
      await preparedWait;
    }
  };
  f.p.update = async (...args) => {
    updateEntered();
    await updateWait;
    return update(...args);
  };
  const original = f.service.save(c, { ...(await f.service.load(c)), ids: ['20'] }).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await preparedSeen;
  const afterFence = await f.service.load(c);
  assert.equal(f.stored().data.pending, undefined);
  const replacement = f.service.save(c, { ...afterFence, ids: ['20'] });
  await updateSeen;
  const winningClaim = structuredClone(f.stored());
  assert.equal(winningClaim.data.pending.phase, 'submitted');
  releasePrepared();
  assert.match((await original).error.message, /not sent to Jira/);
  assert.deepEqual(f.stored(), winningClaim);
  assert.equal(f.writes(), 0);
  releaseUpdate();
  await replacement;
  assert.equal(f.writes(), 1);
  assert.equal(f.stored().data.pending, undefined);
});

test('release is refused when Jira no longer holds the pre-save state, even with a current fingerprint', async () => {
  const f = fixture();
  await f.p.cas('10', 0, {
    ids: [],
    managed: null,
    pending: {
      before: hash([doc('Something else'), []]),
      after: 'unobserved',
      ids: ['20'],
      managed: null,
      keys: ['TEST-20'],
      shape: 'unobserved',
      beforeField: hash(['field', []]),
      beforeBlock: 'a block Jira no longer holds',
      afterBlock: 'unobserved',
      attemptId: 'original',
      phase: 'submitted',
      started: Date.now() - 120_001,
    },
  });
  const status = await f.service.saveStatus(c);
  assert.equal(status.unchanged, false);
  const before = structuredClone(f.stored());
  await assert.rejects(
    f.service.resolveSave(c, { ...status, acknowledged: true }),
    /differs from the pre-save state/,
  );
  assert.deepEqual(f.stored(), before);
  assert.equal(f.writes(), 0);
});
