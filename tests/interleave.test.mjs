import './typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { createService } = await import('../src/service.ts');

// Seeded interleaving explorer for the save protocol. Every port call yields to a scheduler that
// resumes pending calls in a pseudo-random order, so the real service runs under many distinct
// interleavings. Storage is strongly consistent compare-and-set (as Forge custom entities are);
// Jira is last-write-wins. Faults: lost storage and Jira responses, Jira normalizing stored ADF,
// PUTs that never reach Jira, PUTs that land after their invocation failed, and a concurrent
// native Description edit.
const c = { accountId: 'u', projectId: '1', issueId: '10' };
const FIELD = 'customfield_1';
const paragraph = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const doc = (...content) => ({ type: 'doc', version: 1, content });
const SEEDS = 400;

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}
function normalize(description) {
  if (!description) return description;
  const copy = structuredClone(description);
  let n = 0;
  const visit = (node) => {
    if (node.type === 'paragraph') node.attrs = { ...node.attrs, localId: `j${++n}` };
    node.content?.forEach(visit);
  };
  copy.content.forEach(visit);
  return copy;
}
const block = (description) =>
  (description?.content ?? []).filter((node) => node.attrs?.localId === 'npl-10');

function world(seed, features) {
  const random = rng(seed);
  const waiting = [];
  const gate = () => new Promise((resolve) => waiting.push(resolve));
  let stored;
  const late = [];
  const jira = {
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
  const source = (id, text) => ({
    id,
    key: `TEST-${id}`,
    fields: {
      project: { id: '1' },
      issuetype: { id: '3' },
      summary: `S${id}`,
      updated: '1',
      description: doc(paragraph(text)),
    },
  });
  const sources = { 20: source('20', 'Alpha'), 21: source('21', 'Beta') };
  const stats = { puts: 0, unclaimedPut: false, inFlight: 0, maxInFlight: 0 };
  const apply = (fields) => {
    const next = structuredClone(fields);
    if (features.normalize && next.description) next.description = normalize(next.description);
    Object.assign(jira.fields, next);
    jira.fields.updated += '1';
  };
  const p = {
    config: async () => (await gate(), '3'),
    field: async () => (await gate(), FIELD),
    allowed: async () => void (await gate()),
    search: async () => (await gate(), { prompts: [], incomplete: false }),
    issue: async (id) => (await gate(), structuredClone(id === '10' ? jira : sources[id])),
    get: async () => (await gate(), structuredClone(stored)),
    cas: async (_id, revision, data) => {
      await gate();
      if ((stored?.revision ?? 0) !== revision) throw Error('conflict');
      stored = { revision: revision + 1, data: structuredClone(data) };
      if (features.lostStorage && random() < 0.15) throw Error('lost storage response');
    },
    update: async (_id, fields) => {
      await gate();
      // Every PUT must be sent under this app's submitted claim.
      if (stored?.data.pending?.phase !== 'submitted') stats.unclaimedPut = true;
      stats.puts++;
      stats.inFlight++;
      stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
      await gate();
      stats.inFlight--;
      if (features.dropped && random() < 0.4) throw Error('connection failed before Jira');
      if (features.delayed && random() < 0.3) {
        // The invocation fails; Jira applies the request later.
        late.push(() => apply(fields));
        throw Error('timed out');
      }
      apply(fields);
      if (features.lostJira && random() < 0.2) throw Error('lost jira response');
    },
  };
  async function drive(tasks) {
    const settled = tasks.map((t) =>
      t.then(
        (value) => ({ value }),
        (error) => ({ error }),
      ),
    );
    let done = false;
    const all = Promise.all(settled).then((r) => ((done = true), r));
    while (!done) {
      await new Promise(setImmediate);
      if (waiting.length) waiting.splice(Math.floor(random() * waiting.length), 1)[0]();
    }
    return all;
  }
  async function nativeEdit() {
    // Land at a random point of the savers' work, including after a claim.
    for (let i = Math.floor(random() * 16); i >= 0; i--) await gate();
    jira.fields.description = {
      ...jira.fields.description,
      content: [...(jira.fields.description?.content ?? []), paragraph('Native edit')],
    };
    jira.fields.updated += 'n';
  }
  return {
    p,
    service: createService(p),
    jira,
    drive,
    late,
    stats,
    nativeEdit,
    random,
    stored: () => stored,
  };
}

async function explore(seed, now) {
  const r = rng(seed * 7919);
  const features = {
    normalize: r() < 0.5,
    lostStorage: r() < 0.4,
    lostJira: r() < 0.4,
    delayed: r() < 0.3,
    dropped: r() < 0.3,
    native: r() < 0.3,
  };
  const faulty = features.lostStorage || features.lostJira || features.delayed || features.dropped;
  const w = world(seed, features);
  const label = `seed ${seed} ${JSON.stringify(features)}`;
  const base = (await w.drive([w.service.load(c)]))[0].value;
  // Two savers from the same loaded revision, a reader, a status check, maybe a native editor.
  const results = await w.drive([
    w.service.save(c, { ...base, ids: ['20'] }),
    w.service.save(c, { ...base, ids: ['21'] }),
    w.service.load(c),
    w.service.saveStatus(c),
    ...(features.native ? [w.nativeEdit()] : []),
  ]);
  assert.equal(w.stats.unclaimedPut, false, `${label}: PUT without a submitted claim`);
  assert.ok(w.stats.maxInFlight <= 1, `${label}: overlapping PUTs`);
  assert.ok(w.stats.puts <= 1, `${label}: ${w.stats.puts} PUTs`);
  const successes = results.slice(0, 2).filter((x) => x.value);
  assert.ok(successes.length <= 1, `${label}: two savers reported success`);
  for (const success of successes)
    if (!w.late.length)
      assert.deepEqual(
        w.jira.fields[FIELD],
        success.value.ids.map((id) => `TEST-${id}`),
        `${label}: reported success differs from Jira`,
      );

  // Delayed requests land after their invocations failed.
  for (const land of w.late.splice(0)) land();
  // Two minutes later an administrator inspects the ticket and releases or accepts.
  now.value += 130_000;
  const putsBefore = w.stats.puts;
  let outcome = successes.length ? 'saved' : 'unsaved';
  const [status] = await w.drive([w.service.saveStatus({ ...c, accountId: 'admin' })]);
  if (status.value?.pending) {
    // The server must refuse whatever the UI would not offer, so try both regardless.
    const input = { ...status.value, acknowledged: true };
    // Judge each action by its effect on storage: a committed write may lose its response.
    const settled = () => !w.stored()?.data.pending;
    await w.drive([w.service.acceptSave(c, input)]);
    const accepted = settled();
    if (!accepted) await w.drive([w.service.resolveSave(c, input)]);
    const released = !accepted && settled();
    assert.equal(accepted, !!status.value.adoptable, `${label}: accept disagrees with status`);
    assert.equal(released, !!status.value.unchanged, `${label}: release disagrees with status`);
    outcome = accepted ? 'accepted' : released ? 'released' : 'pending';
  } else if (status.value && !successes.length && w.stats.puts) outcome = 'observed';
  assert.equal(w.stats.puts, putsBefore, `${label}: recovery wrote Jira`);

  // A quiet read settles or reports pending; settled storage must describe Jira exactly.
  const [quiet] = await w.drive([w.service.saveStatus(c)]);
  const st = w.stored();
  if (quiet.value && !quiet.value.pending) {
    assert.deepEqual(
      (st?.data.ids ?? []).map((id) => `TEST-${id}`),
      w.jira.fields[FIELD] ?? [],
      `${label}: settled ids disagree with the field`,
    );
    assert.equal(block(w.jira.fields.description).length, st?.data.managed ? 1 : 0, label);
    // With no fault other than normalization, the ticket stays usable: deselect removes the block.
    const [cleared] = await w.drive([
      (async () => w.service.save(c, { ...(await w.service.load(c)), ids: [] }))(),
    ]);
    if (cleared.value) {
      assert.deepEqual(w.jira.fields[FIELD] ?? [], [], `${label}: deselect left the field`);
      assert.equal(block(w.jira.fields.description).length, 0, `${label}: deselect left the block`);
    } else if (!faulty) assert.fail(`${label}: deselect failed: ${cleared.error?.message}`);
  } else if (!faulty && !features.native)
    assert.fail(`${label}: normalization alone left the ticket unresolved`);
  return outcome;
}

test('the save protocol stays safe and recoverable across seeded interleavings and faults', async (t) => {
  const now = { value: 1_000_000_000 };
  t.mock.method(Date, 'now', () => now.value);
  const outcomes = {};
  for (let seed = 1; seed <= SEEDS; seed++) {
    const outcome = await explore(seed, now);
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
  }
  // Coverage guard: each recovery path is actually exercised, so the test cannot go vacuous.
  for (const outcome of ['saved', 'released', 'accepted', 'pending'])
    assert.ok(outcomes[outcome] > 0, `no ${outcome} outcome in ${JSON.stringify(outcomes)}`);
});
