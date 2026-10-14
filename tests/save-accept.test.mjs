import './support/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { createService, hash } = await import('../src/service.ts');
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
    age() {
      stored.data.pending.started = Date.now() - 120_001;
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

const block = (description) => description.content.find((node) => node.type === 'expand');

test('a confirmed save that Jira normalizes is accepted by the saver without stranding', async () => {
  const f = fixture();
  f.jira = normalizeLocalIds;
  const saved = await f.save(['20']);
  assert.deepEqual(saved.ids, ['20']);
  assert.equal(f.stored().data.pending, undefined);
  assert.equal(f.writes(), 1);
  // The stored fingerprint is Jira's block, so the next save proves ownership and removes it.
  f.jira = (fields) => fields;
  await f.save([]);
  assert.equal(block(f.target.fields.description), undefined);
  assert.deepEqual(f.target.fields[FIELD], []);
  assert.equal(f.writes(), 2);
});

test('a lost normalized save is adoptable after two minutes and accept writes only storage', async () => {
  const f = fixture();
  f.jira = normalizeLocalIds;
  f.lose = true;
  await assert.rejects(f.save(['20']), /could not be confirmed/);
  f.lose = false;
  await assert.rejects(f.service.load(c), /could not be verified/);
  let status = await f.service.saveStatus(c);
  assert.equal(status.unchanged, false);
  assert.equal(status.adoptable, true);
  assert.deepEqual(status.keys, ['TEST-20']);
  assert.ok(status.waitSeconds > 0);
  await assert.rejects(
    f.service.acceptSave(c, { ...status, acknowledged: true }),
    /Wait two minutes/,
  );
  f.age();
  status = await f.service.saveStatus(c);
  await assert.rejects(f.service.acceptSave(c, { ...status, acknowledged: false }), /acknowledge/);
  assert.deepEqual(await f.service.acceptSave(c, { ...status, acknowledged: true }), {
    accepted: true,
  });
  assert.equal(f.writes(), 1);
  assert.deepEqual(f.stored().data.ids, ['20']);
  const loaded = await f.service.load(c);
  assert.deepEqual(loaded.ids, ['20']);
  f.jira = (fields) => fields;
  await f.service.save(c, { ...loaded, ids: [] });
  assert.equal(block(f.target.fields.description), undefined);
});

test('a lost Sync that never applied is not adoptable after a Jira edit in the old section', async () => {
  const f = fixture();
  await f.save(['20']);
  f.sources[20].text = 'Updated instructions';
  // The refresh PUT never reaches Jira.
  f.jira = () => ({});
  f.lose = true;
  await assert.rejects(f.save(['20']), /could not be confirmed/);
  // Someone fixes a typo inside the old block: same keys, one block, same localId.
  const old = block(f.target.fields.description);
  old.content[1].content[0].text = 'Instructions (edited)';
  f.target.fields.updated += 'x';
  f.age();
  const status = await f.service.saveStatus(c);
  assert.equal(status.unchanged, false);
  assert.equal(status.adoptable, false);
  await assert.rejects(
    f.service.acceptSave(c, { ...status, acknowledged: true }),
    /no longer matches/,
  );
  assert.ok(f.stored().data.pending);
});

test('a different field value, a duplicated block or a nested block is not adoptable', async () => {
  for (const change of [
    (t) => {
      t.fields[FIELD] = ['TEST-20', 'TEST-21'];
    },
    (t) => {
      t.fields.description.content.push(structuredClone(block(t.fields.description)));
    },
    (t) => {
      const owned = block(t.fields.description);
      t.fields.description.content = [
        { type: 'blockquote', content: [paragraph('Wrapper')] },
        { ...owned, type: 'panel' },
      ];
    },
  ]) {
    const f = fixture();
    f.jira = normalizeLocalIds;
    f.lose = true;
    await assert.rejects(f.save(['20']), /could not be confirmed/);
    change(f.target);
    f.age();
    const status = await f.service.saveStatus(c);
    assert.equal(status.adoptable, false);
    await assert.rejects(f.service.acceptSave(c, { ...status, acknowledged: true }));
    assert.ok(f.stored().data.pending);
  }
});

test('pre-save content is the release case, never adoptable', async () => {
  const f = fixture();
  f.jira = () => ({});
  f.lose = true;
  await assert.rejects(f.save(['20']), /could not be confirmed/);
  f.age();
  const status = await f.service.saveStatus(c);
  assert.equal(status.unchanged, true);
  assert.equal(status.adoptable, false);
  await assert.rejects(f.service.acceptSave(c, { ...status, acknowledged: true }), /no longer/);
});

test('an unapplied save stays releasable after a Jira Description edit outside the section', async () => {
  for (const sync of [false, true]) {
    const f = fixture();
    if (sync) {
      await f.save(['20']);
      f.sources[20].text = 'Updated instructions';
    }
    // The PUT never reaches Jira (a timeout or 5xx before processing).
    f.jira = () => ({});
    f.lose = true;
    await assert.rejects(f.save(['20']), /could not be confirmed/);
    // Ordinary team activity elsewhere in the Description.
    f.target.fields.description.content.unshift(paragraph('Team note'));
    f.target.fields.updated += 'n';
    f.age();
    const status = await f.service.saveStatus(c);
    assert.equal(status.unchanged, true, sync ? 'sync' : 'save');
    const writes = f.writes();
    assert.deepEqual(await f.service.resolveSave(c, { ...status, acknowledged: true }), {
      resolved: true,
    });
    assert.equal(f.writes(), writes);
    f.lose = false;
    f.jira = (fields) => fields;
    assert.deepEqual((await f.service.load(c)).ids, sync ? ['20'] : []);
    // The released record allows a new save that keeps the team note.
    await f.save(['20']);
    assert.equal(f.target.fields.description.content[0].content[0].text, 'Team note');
  }
});

test('a save that did reach Jira is never released as unapplied, even after other edits', async () => {
  for (const sync of [false, true]) {
    const f = fixture();
    if (sync) {
      await f.save(['20']);
      f.sources[20].text = 'Updated instructions';
    }
    // Jira applies the PUT and the response is lost.
    f.lose = true;
    await assert.rejects(f.save(['20']), /could not be confirmed/);
    f.target.fields.description.content.unshift(paragraph('Team note'));
    f.target.fields.updated += 'n';
    f.age();
    const status = await f.service.saveStatus(c);
    assert.equal(status.unchanged, false, sync ? 'sync' : 'save');
    assert.equal(status.adoptable, true);
    await assert.rejects(
      f.service.resolveSave(c, { ...status, acknowledged: true }),
      /differs from the pre-save state/,
    );
  }
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

test('a lost Sync that changed only a link and never landed is released, not accepted', async () => {
  const f = fixture();
  const link = (href) => ({
    type: 'paragraph',
    content: [{ type: 'text', text: 'Docs', marks: [{ type: 'link', attrs: { href } }] }],
  });
  const issue = f.p.issue;
  let href = 'https://old.example';
  f.p.issue = async (id) => {
    const value = await issue(id);
    if (id === '20') value.fields.description = doc(link(href));
    return value;
  };
  await f.save(['20']);
  href = 'https://new.example';
  f.jira = () => ({});
  f.lose = true;
  await assert.rejects(f.save(['20']), /could not be confirmed/);
  f.target.fields.description.content.unshift(paragraph('Team note'));
  f.target.fields.updated += 'n';
  f.age();
  const status = await f.service.saveStatus(c);
  assert.equal(status.adoptable, false);
  assert.equal(status.unchanged, true);
  await assert.rejects(f.service.acceptSave(c, { ...status, acknowledged: true }), /no longer/);
});

test('accept requires Administer Jira, Edit work items and the inspected revision and work item', async () => {
  const f = fixture();
  f.jira = normalizeLocalIds;
  f.lose = true;
  await assert.rejects(f.save(['20']), /could not be confirmed/);
  f.age();
  const status = await f.service.saveStatus(c);
  const before = structuredClone(f.stored());
  for (const [input, setup] of [
    [{ ...status, acknowledged: true, revision: status.revision + 1 }, () => {}],
    [{ ...status, acknowledged: true, fingerprint: 'stale' }, () => {}],
    [{ ...status, acknowledged: true }, () => f.allowed.delete('ADMINISTER')],
    [{ ...status, acknowledged: true }, () => f.allowed.delete('EDIT_ISSUES')],
  ]) {
    f.allowed = new Set(['ADMINISTER', 'EDIT_ISSUES']);
    setup();
    await assert.rejects(f.service.acceptSave(c, input));
    assert.deepEqual(f.stored(), before);
  }
  assert.equal(f.writes(), 1);
});

test('the original saver cannot settle storage after an administrator accepted it', async () => {
  const f = fixture();
  f.jira = normalizeLocalIds;
  f.lose = true;
  await assert.rejects(f.save(['20']), /could not be confirmed/);
  f.age();
  const status = await f.service.saveStatus(c);
  await f.service.acceptSave(c, { ...status, acknowledged: true });
  const accepted = structuredClone(f.stored());
  // A late original invocation retries its final conditional write at its old revision.
  await assert.rejects(f.p.cas('10', status.revision, { ids: ['20'], managed: null }), /conflict/);
  assert.deepEqual(f.stored(), accepted);
});

test('deselecting a block the user deleted clears only the field and leaves Description untouched', async () => {
  const f = fixture();
  await f.save(['20']);
  f.target.fields.description = doc(paragraph('Original'), paragraph('User text'));
  f.target.fields.updated += 'x';
  const description = structuredClone(f.target.fields.description);
  const loaded = await f.service.load(c);
  await assert.rejects(
    f.service.save(c, { ...loaded, ids: ['20', '21'] }),
    /section was removed in Jira. Remove all prompts and save/,
  );
  await assert.rejects(f.service.save(c, { ...loaded, ids: ['20'] }), /section was removed/);
  assert.equal(f.writes(), 1);
  await f.service.save(c, { ...loaded, ids: [] });
  assert.deepEqual(f.sent.at(-1), { [FIELD]: [] });
  assert.deepEqual(f.target.fields.description, description);
  assert.deepEqual(f.stored().data, { ids: [], managed: null });
  // Adding prompts again starts a fresh block.
  await f.save(['21']);
  assert.ok(block(f.target.fields.description));
});

test('forgetting a deleted block with an already empty field needs no Jira write', async () => {
  const f = fixture();
  await f.save(['20']);
  f.target.fields.description = doc(paragraph('Original'));
  f.target.fields[FIELD] = [];
  f.target.fields.updated += 'x';
  await f.save([]);
  assert.equal(f.writes(), 1);
  assert.deepEqual(f.stored().data, { ids: [], managed: null });
});

test('a Jira Description edit racing the forget save survives and the field receipt settles', async () => {
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
  assert.deepEqual(f.stored().data, { ids: [], managed: null });
});

test('a lost forget save settles by observation, or is releasable when Jira is unchanged', async () => {
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
  const status = await unapplied.service.saveStatus(c);
  assert.equal(status.unchanged, true);
  assert.deepEqual(await unapplied.service.resolveSave(c, { ...status, acknowledged: true }), {
    resolved: true,
  });
  assert.equal(hash(unapplied.stored().data.ids), hash(['20']));
});
