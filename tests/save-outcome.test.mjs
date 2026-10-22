import './support/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { createService, hash, JiraRejected } = await import('../src/service.ts');
const c = { accountId: 'admin', projectId: '1', issueId: '10' };
const doc = (...content) => ({ type: 'doc', version: 1, content });
const paragraph = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const FIELD = 'customfield_1';

function fixture() {
  let stored,
    writes = 0;
  const sent = [];
  const target = {
    id: '10',
    key: 'TEST-10',
    fields: {
      project: { id: '1' },
      issuetype: { id: '2' },
      summary: 'Work',
      updated: '1',
      description: doc(paragraph('Original')),
    },
  };
  const sources = {
    20: { key: 'TEST-20', text: 'Instructions' },
    21: { key: 'TEST-21', text: 'Checklist' },
  };
  const f = {
    target,
    sources,
    // Applied to every PUT that reaches Jira; returning true loses the response afterwards.
    jira: (fields) => fields,
    lose: false,
    allowed: new Set(['ADMINISTER', 'EDIT_ISSUES']),
  };
  const p = {
    refreshAfterSave: async () => false,
    retainedTypes: async () => [],
    config: async () => '3',
    field: async () => FIELD,
    allowed: async (_project, permission) => {
      if (!f.allowed.has(permission)) throw Error(`denied ${permission}`);
    },
    search: async () => ({ prompts: [], incomplete: false }),
    issue: async (id) =>
      structuredClone(
        id === '10'
          ? target
          : {
              id,
              key: sources[id].key,
              fields: {
                project: { id: '1' },
                issuetype: { id: '3' },
                summary: `Prompt ${id}`,
                updated: '1',
                description: doc(paragraph(sources[id].text)),
              },
            },
      ),
    get: async () => structuredClone(stored),
    cas: async (_id, revision, data) => {
      if ((stored?.revision ?? 0) !== revision) throw Error('conflict');
      stored = { revision: revision + 1, data: structuredClone(data) };
    },
    update: async (_id, fields) => {
      writes++;
      sent.push(structuredClone(fields));
      Object.assign(target.fields, structuredClone(f.jira(fields)));
      target.fields.updated += '1';
      if (f.lose) throw Error('lost');
    },
  };
  return Object.assign(f, {
    p,
    service: createService(p),
    stored: () => stored,
    writes: () => writes,
    sent,
    async save(ids) {
      return f.service.save(c, { ...(await f.service.load(c)), ids });
    },
    sync: () => f.service.save(c, { sync: true }),
    age() {
      stored.data.pending.started = Date.now() - 120_001;
    },
    async release() {
      const status = await f.service.saveStatus(c);
      return f.service.resolveSave(c, { ...status, acknowledged: true });
    },
  });
}

// Jira assigns editor identifiers to nodes it stores; text and structure are unchanged.
function normalizeLocalIds(fields) {
  if (!fields.description) return fields;
  const description = structuredClone(fields.description);
  let n = 0;
  const visit = (node) => {
    if (node.type === 'paragraph') node.attrs = { ...node.attrs, localId: `jira-${++n}` };
    node.content?.forEach(visit);
  };
  description.content.forEach(visit);
  return { ...fields, description };
}

const blocks = (description) =>
  (description?.content ?? []).filter((node) => node.attrs?.title === 'Agent Prompts');
const block = (description) => blocks(description)[0];

test('a confirmed save settles in whatever form Jira stores it, and the next save replaces it', async () => {
  const f = fixture();
  f.jira = normalizeLocalIds;
  const saved = await f.save(['20']);
  assert.deepEqual(saved.ids, ['20']);
  assert.deepEqual(f.stored().data, { ids: ['20'], keys: ['TEST-20'] });
  assert.equal(f.writes(), 1);
  f.jira = (fields) => fields;
  await f.save([]);
  assert.deepEqual(blocks(f.target.fields.description), []);
  assert.deepEqual(f.target.fields[FIELD], []);
  assert.equal(f.writes(), 2);
});

test('a lost save settles by itself once Jira’s field holds the keys it sent', async () => {
  for (const jira of [(fields) => fields, normalizeLocalIds]) {
    const f = fixture();
    f.jira = jira;
    f.lose = true;
    await assert.rejects(f.save(['20']), /could not be confirmed/);
    f.lose = false;
    // Edits made since, in or outside the section, don't matter.
    block(f.target.fields.description).content.push(paragraph('User note'));
    f.target.fields.description.content.unshift(paragraph('Team note'));
    assert.deepEqual((await f.service.load(c)).ids, ['20']);
    assert.equal(f.stored().data.pending, undefined);
    await f.sync();
    assert.deepEqual(blocks(f.target.fields.description).length, 1);
    assert.doesNotMatch(JSON.stringify(f.target.fields.description), /User note/);
    assert.match(JSON.stringify(f.target.fields.description), /Team note/);
  }
});

test('a lost save Jira doesn’t show is released by an administrator, and Sync then rewrites the section', async () => {
  // The PUT never reached Jira; or it was a Sync that changed only the description, which Jira
  // stored in its own form; or it reached Jira and the section was then edited or deleted.
  const cases = {
    'never reached': (f) => (f.jira = () => ({})),
    'sync normalized': (f) => (f.jira = normalizeLocalIds),
    'section edited': () => {},
    'section deleted': () => {},
  };
  for (const [name, setup] of Object.entries(cases)) {
    const f = fixture();
    await f.save(['20']);
    f.sources[20].text = 'Updated instructions';
    setup(f);
    f.lose = true;
    await assert.rejects(f.sync(), /could not be confirmed/, name);
    f.lose = false;
    f.jira = (fields) => fields;
    if (name === 'section edited')
      block(f.target.fields.description).content.push(paragraph('User note'));
    if (name === 'section deleted') f.target.fields.description = doc(paragraph('Original'));
    f.target.fields.description.content.unshift(paragraph('Team note'));
    f.target.fields.updated += 'u';
    await assert.rejects(f.service.load(c), /previous save could not be verified/, name);
    await assert.rejects(f.release(), /Wait two minutes/, name);
    f.age();
    const writes = f.writes();
    assert.deepEqual(await f.release(), { resolved: true }, name);
    assert.equal(f.writes(), writes, name);
    assert.deepEqual(f.stored().data, { ids: ['20'], keys: ['TEST-20'] }, name);
    await f.sync();
    const description = f.target.fields.description;
    assert.equal(blocks(description).length, 1, name);
    assert.match(JSON.stringify(block(description)), /Updated instructions/, name);
    assert.doesNotMatch(JSON.stringify(description), /User note/, name);
    assert.equal(description.content[0].content[0].text, 'Team note', name);
  }
});

test('a released save keeps the last saved prompts, whatever the lost save chose', async () => {
  const f = fixture();
  await f.save(['20']);
  f.jira = () => ({});
  f.lose = true;
  await assert.rejects(f.save(['20', '21']), /could not be confirmed/);
  f.lose = false;
  f.jira = (fields) => fields;
  f.age();
  await f.release();
  assert.deepEqual((await f.service.load(c)).ids, ['20']);
  await f.save(['20', '21']);
  assert.deepEqual(f.target.fields[FIELD], ['TEST-20', 'TEST-21']);
});

test('pending prompt keys are shown only to an administrator with Edit work items', async () => {
  const f = fixture();
  // The PUT never reaches Jira, so the save stays pending.
  f.jira = () => ({});
  f.lose = true;
  await assert.rejects(f.save(['20']), /could not be confirmed/);
  f.allowed = new Set(['EDIT_ISSUES']);
  const viewer = await f.service.saveStatus(c);
  assert.equal(viewer.administrator, false);
  assert.equal('keys' in viewer, false);
  f.allowed = new Set(['ADMINISTER', 'EDIT_ISSUES']);
  assert.deepEqual((await f.service.saveStatus(c)).keys, ['TEST-20']);
});

test('release requires Administer Jira, Edit work items and the inspected revision and work item', async () => {
  const f = fixture();
  f.jira = () => ({});
  f.lose = true;
  await assert.rejects(f.save(['20']), /could not be confirmed/);
  f.age();
  const status = await f.service.saveStatus(c);
  const before = structuredClone(f.stored());
  for (const [input, setup] of [
    [{ ...status, acknowledged: true, revision: status.revision + 1 }, () => {}],
    [{ ...status, acknowledged: true, fingerprint: 'stale' }, () => {}],
    [{ ...status, acknowledged: false }, () => {}],
    [{ ...status, acknowledged: true }, () => f.allowed.delete('ADMINISTER')],
    [{ ...status, acknowledged: true }, () => f.allowed.delete('EDIT_ISSUES')],
  ]) {
    f.allowed = new Set(['ADMINISTER', 'EDIT_ISSUES']);
    setup();
    await assert.rejects(f.service.resolveSave(c, input));
    assert.deepEqual(f.stored(), before);
  }
  assert.equal(f.writes(), 1);
});

test('the original saver cannot settle storage after an administrator released it', async () => {
  const f = fixture();
  f.jira = () => ({});
  f.lose = true;
  await assert.rejects(f.save(['20']), /could not be confirmed/);
  f.age();
  const status = await f.service.saveStatus(c);
  await f.release();
  const released = structuredClone(f.stored());
  // A late original invocation retries its final conditional write at its old revision.
  await assert.rejects(f.p.cas('10', status.revision, { ids: ['20'] }), /conflict/);
  assert.deepEqual(f.stored(), released);
});

test('removing every prompt after the user deleted the section writes only the field', async () => {
  const f = fixture();
  await f.save(['20']);
  f.target.fields.description = doc(paragraph('Original'), paragraph('User text'));
  f.target.fields.updated += 'x';
  const description = structuredClone(f.target.fields.description);
  await f.save([]);
  assert.deepEqual(f.sent.at(-1), { [FIELD]: [] });
  assert.deepEqual(f.target.fields.description, description);
  assert.deepEqual(f.stored().data, { ids: [], keys: [] });
});

test('removing every prompt with the section and field already gone needs no Jira write', async () => {
  const f = fixture();
  await f.save(['20']);
  f.target.fields.description = doc(paragraph('Original'));
  f.target.fields[FIELD] = [];
  f.target.fields.updated += 'x';
  await f.save([]);
  assert.equal(f.writes(), 1);
  assert.deepEqual(f.stored().data, { ids: [], keys: [] });
});

test('a Jira Description edit racing a field-only save survives and the save settles', async () => {
  const f = fixture();
  await f.save(['20']);
  f.target.fields.description = doc(paragraph('Original'));
  f.target.fields.updated += 'x';
  f.jira = (fields) => {
    // A concurrent editor changes Description while the field-only PUT is in flight.
    f.target.fields.description = doc(paragraph('Concurrent edit'));
    return fields;
  };
  await f.save([]);
  assert.deepEqual(f.target.fields.description, doc(paragraph('Concurrent edit')));
  assert.deepEqual(f.stored().data, { ids: [], keys: [] });
});

test('a lost field-only save settles by observation, or is releasable when Jira is unchanged', async () => {
  const applied = fixture();
  await applied.save(['20']);
  applied.target.fields.description = doc(paragraph('Original'));
  applied.target.fields.updated += 'x';
  applied.lose = true;
  await assert.rejects(applied.save([]), /could not be confirmed/);
  applied.lose = false;
  assert.deepEqual((await applied.service.load(c)).ids, []);
  assert.equal(applied.stored().data.pending, undefined);

  const unapplied = fixture();
  await unapplied.save(['20']);
  unapplied.target.fields.description = doc(paragraph('Original'));
  unapplied.target.fields.updated += 'x';
  unapplied.jira = () => ({});
  unapplied.lose = true;
  await assert.rejects(unapplied.save([]), /could not be confirmed/);
  // A native Description edit does not affect a field-only receipt.
  unapplied.target.fields.description = doc(paragraph('Later edit'));
  unapplied.age();
  assert.deepEqual(await unapplied.release(), { resolved: true });
  assert.equal(hash(unapplied.stored().data.ids), hash(['20']));
});

// A reader's work item snapshot can predate a save's claim; it must not settle that claim.
test('a reader whose work item read predates a claim never settles it', async () => {
  const f = fixture();
  await f.save(['20']);
  // Reader L reads the work item, then its storage read waits.
  const get = f.p.get;
  let release;
  const reached = new Promise((resolve) => {
    let armed = true;
    f.p.get = async (...args) => {
      if (armed) {
        armed = false;
        resolve();
        await new Promise((go) => (release = go));
      }
      return get(...args);
    };
  });
  const reader = f.service.load(c).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await reached;
  // Meanwhile the user removes the prompt and adds it back; Jira refuses the second PUT later.
  await f.save([]);
  const update = f.p.update;
  let refuse;
  const sent = new Promise((resolve) => {
    f.p.update = async () => {
      resolve();
      await new Promise((go) => (refuse = go));
      throw new JiraRejected(429, 'Jira is limiting requests. Wait a moment, then try again.');
    };
  });
  const again = f.save(['20']).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await sent;
  // L now sees the submitted claim and compares it with Jira.
  release();
  const read = await reader;
  refuse();
  assert.match((await again).error?.message ?? '', /limiting requests/);
  f.p.update = update;
  assert.match(read.error?.message ?? '', /previous save could not be verified/);
  // Jira never applied the second save, and storage still says so.
  assert.deepEqual(f.target.fields[FIELD], []);
  assert.equal(block(f.target.fields.description), undefined);
  assert.deepEqual(f.stored().data, { ids: [], keys: [] });
});
