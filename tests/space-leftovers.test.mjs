// The configuration Jira keeps after a runner space is deleted (tests/hosted/support/
// space-leftovers.mjs) against an in-memory Jira: what counts as a leftover, and how each delete
// is journaled, read back and kept when in doubt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spaceLeftovers } from './hosted/support/space-leftovers.mjs';
import { fakeJira, kanbanSpace } from './support/fake-jira-setup.mjs';

const deleted = ['NPA0319847', 'NA12C19A3'];
const empty = () => ({
  projects: {},
  typeSchemes: {},
  types: {},
  screens: {},
  screenSchemes: {},
  itss: {},
  workflowSchemes: {},
  workflows: {},
  filters: {},
});
/** Two deleted runner spaces' leftovers, a live runner space and a space of someone else's. */
function site() {
  const world = empty();
  deleted.forEach((key, n) => kanbanSpace(world, key, 1000 * (n + 1)));
  for (const [id, key, base] of [
    ['20000', 'NPB6B4B611', 5000],
    ['20001', 'OTHER', 6000],
  ])
    world.projects[id] = { key, description: '', ...kanbanSpace(world, key, base) };
  // Close to a runner key but not one: lower-case hex, too short.
  kanbanSpace(world, 'NPa031984', 7000);
  kanbanSpace(world, 'NA12C19', 8000);
  return world;
}
const order = [
  'DELETE /issuetypescreenscheme/',
  'DELETE /screenscheme/',
  'DELETE /screens/',
  'DELETE /workflowscheme/',
  'DELETE /workflow/',
  'DELETE /filter/',
];

/** The helper over the fake; every write must follow a journal write made since the previous one. */
function harness(world, options) {
  const jira = fakeJira(world, options);
  let journaled = false;
  const persist = () => (journaled = true);
  const api = (path, method = 'GET', body) => {
    if (method !== 'GET') {
      assert.ok(journaled, `${method} ${path} before its intent was journaled`);
      journaled = false;
    }
    return jira.api(path, method, body);
  };
  return { ...spaceLeftovers(api), ...jira, persist };
}
const kinds = (entries) => {
  const out = {};
  for (const x of entries) out[x.kind] = [...(out[x.kind] ?? []), x.key].sort();
  return out;
};

test('the sweep finds every object of deleted runner spaces and nothing else, across pages', async () => {
  const world = site();
  const h = harness(world);
  const found = await h.find({ live: await h.live() });
  const both = [...deleted].sort();
  assert.deepEqual(kinds(found), {
    'work type screen scheme': both,
    'screen scheme': [...both, ...both, ...both].sort(),
    screen: [...both, ...both, ...both].sort(),
    'workflow scheme': both,
    workflow: both,
    'board filter': both,
  });
  assert.ok(found.every((x) => typeof x.id === 'string' && x.name.includes(x.key)));
});

test('a runner cleanup finds only its own spaces’ objects', async () => {
  const h = harness(site());
  const found = await h.find({ keys: ['NA12C19A3'] });
  assert.equal(found.length, 10);
  assert.ok(found.every((x) => x.key === 'NA12C19A3'));
  assert.deepEqual(await h.find({ keys: [] }), []);
});

test('leftovers are deleted users first, each journaled and read back', async () => {
  const world = site();
  const h = harness(world);
  const entries = await h.find({ live: await h.live() });
  assert.deepEqual(await h.remove(entries, h.persist), []);
  assert.equal(h.writes.length, 20);
  const positions = h.writes.map((w) => order.findIndex((prefix) => w.startsWith(prefix)));
  assert.deepEqual(positions, [...positions].sort());
  assert.ok(entries.every((x) => x.state === 'deleted'));
  // The live spaces and the near-miss names keep everything; without `live`, only the live runner
  // space's objects look like leftovers.
  assert.deepEqual([...new Set((await h.find({})).map((x) => x.key))], ['NPB6B4B611']);
  assert.equal(Object.keys(world.itss).length, 4);
  assert.equal(Object.keys(world.filters).length, 4);
});

test('an object still in use stays, and so does the board filter of its space', async () => {
  const world = site();
  const h = harness(world);
  const entries = await h.find({ live: await h.live() });
  // Someone moved a space onto a deleted runner space's schemes.
  Object.assign(world.projects['20001'], { itss: '1000', workflowScheme: '1000' });
  const stay = await h.remove(entries, h.persist);
  assert.deepEqual(
    stay.map((x) => [x.kind, x.state, x.reason]),
    [
      ['work type screen scheme', 'kept', 'used by a space'],
      ['screen scheme', 'kept', 'used by a work type screen scheme'],
      ['screen scheme', 'kept', 'used by a work type screen scheme'],
      ['screen scheme', 'kept', 'used by a work type screen scheme'],
      ['screen', 'refused', 'Fixture API DELETE failed (HTTP 400): Screen in use'],
      ['screen', 'refused', 'Fixture API DELETE failed (HTTP 400): Screen in use'],
      ['screen', 'refused', 'Fixture API DELETE failed (HTTP 400): Screen in use'],
      ['workflow scheme', 'kept', 'used by a space'],
      ['workflow', 'kept', 'used by a workflow scheme'],
      ['board filter', 'kept', 'another object of its space stays'],
    ],
  );
  assert.ok(stay.every((x) => x.key === deleted[0]));
  assert.ok(world.filters['1000']);
  assert.equal(world.filters['2000'], undefined);
});

test('a changed or foreign board filter stays', async () => {
  for (const change of [
    (f) => (f.jql = 'project = "NPA0319847" AND labels = keep ORDER BY Rank ASC'),
    (f) => (f.owner = 'someone-else'),
  ]) {
    const world = site();
    change(world.filters['1000']);
    const h = harness(world);
    const stay = await h.remove(await h.find({ keys: [deleted[0]] }), h.persist);
    assert.deepEqual(
      stay.map((x) => [x.kind, x.reason]),
      [['board filter', 'changed since Jira created it']],
    );
  }
});

test('a lost delete response is read back on the next run instead of repeated', async () => {
  const world = site();
  const h = harness(world, { lose: 'DELETE /screens/1021' });
  const entries = await h.find({ keys: [deleted[0]] });
  await assert.rejects(h.remove(entries, h.persist), /response lost/);
  assert.equal(entries.find((x) => x.id === '1021').state, 'intent');
  const writes = h.writes.length;
  assert.deepEqual(await h.remove(entries, h.persist), []);
  assert.ok(!h.writes.slice(writes).includes('DELETE /screens/1021'));
  assert.equal(entries.find((x) => x.id === '1021').state, 'deleted');
});

test('a delete Jira refuses is recorded and the rest go on', async () => {
  const world = site();
  const h = harness(world, { refuse: 'DELETE /workflow/workflow-1000' });
  const stay = await h.remove(await h.find({ keys: [deleted[0]] }), h.persist);
  assert.deepEqual(
    stay.map((x) => [x.kind, x.state, x.reason]),
    [
      ['workflow', 'refused', 'Fixture API DELETE failed (HTTP 429)'],
      ['board filter', 'kept', 'another object of its space stays'],
    ],
  );
});

test('a renamed object or a space that exists again stops before any write', async () => {
  for (const [change, expected] of [
    [(world) => (world.itss['1000'].name = 'NPA0319847: Renamed'), /renamed/],
    [(world) => (world.projects['30000'] = { key: deleted[0], description: '' }), /exists/],
  ]) {
    const world = site();
    const h = harness(world);
    const entries = await h.find({ keys: [deleted[0]] });
    change(world);
    await assert.rejects(h.remove(entries, h.persist), expected);
    assert.deepEqual(h.writes, []);
  }
});
