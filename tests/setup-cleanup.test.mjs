// The setup runner's journal-driven cleanup (tests/hosted/verify-setup.mjs) against an in-memory
// Jira, for the journal each runner mode leaves behind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupCleanup } from './hosted/support/setup-cleanup.mjs';
import { fakeJira, kanbanSpace } from './support/fake-jira-setup.mjs';

const id = '0f6c2b1e-7d4a-4c1f-9a2b-3c4d5e6f7a8b';
const description = 'Reusable instructions managed through Agent Prompts for Jira.';
const field = 'customfield_10500';
const mappingsOf = (world) =>
  Object.entries(world.typeSchemes)
    .flatMap(([s, x]) => x.types.map((t) => `${s}:${t}`))
    .sort();

/** A site with the run's empty spaces, each with its own work type scheme, as journaled after
 * creation: Task and Epic in the default scheme, Task in another space's scheme. */
function run(count = 2) {
  const world = {
    projects: {},
    typeSchemes: {
      10000: { name: 'Default work type scheme', isDefault: true, types: ['10001', '10002'] },
      10100: { name: 'OTHER: work type scheme', types: ['10001'] },
    },
    types: {
      10001: { name: 'Task', description: '', hierarchyLevel: 0, subtask: false },
      10002: { name: 'Epic', description: '', hierarchyLevel: 1, subtask: false },
    },
    screens: {},
    screenSchemes: {},
    itss: {},
  };
  const j = {
    id,
    site: 'https://owned.atlassian.net',
    shared: false,
    sharedScreens: false,
    steps: false,
    fixtures: [],
    typeName: `Setup ${id}`,
    stage: 'cleanup',
    clean: false,
    actor: 'admin',
    defaultScheme: '10000',
  };
  for (let n = 0; n < count; n++) {
    const key = `NP0F6C2B1${n}`;
    const scheme = { id: String(21000 + n), name: `${key}: Kanban Work Type Scheme` };
    world.projects[20000 + n] = {
      key,
      description: `Setup run marker ${n}`,
      scheme: scheme.id,
      itss: String(50000 + n),
    };
    world.typeSchemes[scheme.id] = { name: scheme.name, types: ['10001'] };
    j.fixtures.push({
      key,
      marker: `Setup run marker ${n}`,
      projectIntent: true,
      project: { id: String(20000 + n), key },
      scheme,
    });
  }
  j.mappingBaseline = mappingsOf(world);
  return { world, j };
}

/** The run's new work type, renamed and attached to the given schemes. */
function addType(world, j, schemes) {
  world.types[30001] = { name: `Renamed ${id}`, description, hierarchyLevel: 0, subtask: false };
  for (const s of schemes) world.typeSchemes[s].types.push('30001');
  Object.assign(j, {
    typeIntent: true,
    type: { id: '30001', name: j.typeName, description, hierarchyLevel: 0, subtask: false },
    renamed: `Renamed ${id}`,
  });
}

/** Cleanup over the fake. Every write must follow a journal write made since the previous one;
 * `before` keeps the journal as persisted just before each write. */
function harness(world, j, options) {
  const jira = fakeJira(world, options);
  const snapshots = [];
  const before = [];
  let journaled = false;
  const persist = () => {
    snapshots.push(structuredClone(j));
    journaled = true;
  };
  const api = (path, method = 'GET', body) => {
    if (method !== 'GET' && path !== '/search/jql') {
      assert.ok(journaled, `${method} ${path} before its intent was journaled`);
      journaled = false;
      before.push(snapshots.at(-1));
    }
    return jira.api(path, method, body);
  };
  const { cleanup } = setupCleanup({ j, api, persist });
  return { cleanup, ...jira, snapshots, before };
}

const removeSpaces = (j) => [
  ...j.fixtures.map((f) => `DELETE /project/${f.project.id}?enableUndo=false`),
  ...j.fixtures.map((f) => `DELETE /issuetypescheme/${f.scheme.id}`),
];
// What the site keeps once the run is gone: only the schemes that predate it.
function assertSiteRestored(world, j) {
  assert.deepEqual(world.projects, {});
  assert.deepEqual(
    mappingsOf(world),
    j.mappingBaseline.filter((m) => !j.fixtures.some((f) => m.startsWith(`${f.scheme.id}:`))),
  );
}
function assertClean(h, j) {
  assert.equal(j.clean, true);
  assert.equal(h.snapshots.at(-1).clean, true, 'The clean journal is persisted');
}

test('cleanup after a default run deletes the work type, both spaces and their schemes', async () => {
  const { world, j } = run();
  addType(world, j, ['21000', '21001', '10000']);
  Object.assign(j, { detachIntent: true, passed: true });
  const h = harness(world, j);
  await h.cleanup();
  assert.deepEqual(h.writes, ['DELETE /issuetype/30001', ...removeSpaces(j)]);
  assert.equal(h.before[0].typeDeleteIntent, true);
  assert.equal(j.typeDeleted, true);
  assert.equal(world.types[30001], undefined);
  assertSiteRestored(world, j);
  assertClean(h, j);
});

test('cleanup before steps mode planned its fixtures reads no screens', async () => {
  const { world, j } = run();
  addType(world, j, ['21000', '21001']);
  j.steps = true;
  const h = harness(world, j);
  await h.cleanup();
  assert.deepEqual(h.writes, ['DELETE /issuetype/30001', ...removeSpaces(j)]);
  // Only the search for what Jira kept of the deleted spaces, by space key.
  const keys = j.fixtures.map((f) => `queryString=${f.key}&`).join('|');
  const leftovers = new RegExp(`^GET /(screens|screenscheme|issuetypescreenscheme)\\?(${keys})`);
  assert.ok(
    !h.calls.some(
      (c) => /^\w+ \/(screens|screenscheme|issuetypescreenscheme)/.test(c) && !leftovers.test(c),
    ),
  );
  assertClean(h, j);
});

test('cleanup deletes what Jira created with each space once the spaces are gone', async () => {
  const { world, j } = run();
  for (const [n, f] of j.fixtures.entries())
    Object.assign(world.projects[f.project.id], kanbanSpace(world, f.key, 60000 + 100 * n));
  kanbanSpace(world, 'OTHER', 61000);
  world.projects[20100] = { key: 'OTHER', description: '', scheme: '10100', itss: '61000' };
  const h = harness(world, j);
  await h.cleanup();
  const spaces = removeSpaces(j);
  assert.deepEqual(h.writes.slice(0, spaces.length), spaces);
  // Per space: one work type screen scheme, three screen schemes and screens, one of the rest.
  const each = { issuetypescreenscheme: 2, screenscheme: 6, screens: 6 };
  assert.deepEqual(
    h.writes.slice(spaces.length).map((w) => w.split('/')[1]),
    [
      'issuetypescreenscheme',
      'screenscheme',
      'screens',
      'workflowscheme',
      'workflow',
      'filter',
    ].flatMap((kind) => Array(each[kind] ?? 2).fill(kind)),
  );
  assert.ok(
    h.before.slice(spaces.length).every((s) => s.leftovers.some((x) => x.state === 'intent')),
  );
  assert.ok(j.leftovers.every((x) => x.state === 'deleted'));
  assert.deepEqual(Object.keys(world.itss), ['61000']);
  assert.deepEqual(Object.keys(world.filters), ['61000']);
  assertClean(h, j);
});

test('cleanup after a bulk run removes leftover fields and restores the create screen', async () => {
  // Regression: outside steps mode `j.steps` is false, which cleanup once read as planned fixtures.
  const { world, j } = run();
  world.screens = {
    30101: { name: 'NP0F6C2B10: Bug edit', tabs: [{ id: 40101, fields: ['summary'] }] },
    30102: { name: 'NP0F6C2B10: Bug view', tabs: [{ id: 40102, fields: ['summary'] }] },
    // The field placed by hand on the second space's screen, on its second tab.
    30103: {
      name: 'NP0F6C2B11: Bug edit',
      tabs: [
        { id: 40103, fields: ['summary'] },
        { id: 40113, fields: [field] },
      ],
    },
    30104: { name: 'NP0F6C2B11: Bug view', tabs: [{ id: 40104, fields: ['summary'] }] },
    // Description is back on the create screen; Summary is not.
    30105: { name: 'NP0F6C2B10: Task create', tabs: [{ id: 40105, fields: ['description'] }] },
  };
  Object.assign(j, {
    field,
    screens: ['30101', '30102', '30103', '30104'],
    manualScreen: '30103',
    createScreen: '30105',
    requiredRemoved: [
      { screen: '30105', tab: '40105', field: 'description' },
      { screen: '30105', tab: '40105', field: 'summary' },
    ],
    manualIntent: true,
    passed: true,
  });
  const h = harness(world, j);
  await h.cleanup();
  assert.deepEqual(h.writes, [
    `DELETE /screens/30103/tabs/40113/fields/${field}`,
    'POST /screens/30105/tabs/40105/fields {"fieldId":"summary"}',
    ...removeSpaces(j),
    // The spaces' own screens go only after them.
    ...['30101', '30102', '30105', '30103', '30104'].map((x) => `DELETE /screens/${x}`),
  ]);
  assert.equal(h.before[0].screenCleanupIntent, true);
  assert.deepEqual(
    h.before[1].requiredRemoved.map((x) => x.restoreIntent),
    [undefined, true],
  );
  assert.deepEqual(world.screens, {});
  assertSiteRestored(world, j);
  assertClean(h, j);
});

test('cleanup after a shared scheme run deletes the shared scheme once no space uses it', async () => {
  const { world, j } = run(3);
  j.shared = true;
  for (const n of [1, 2]) {
    j.fixtures[n].shareIntent = true;
    world.projects[20000 + n].scheme = '21000';
  }
  // Attached through the shared scheme only; the other two schemes keep their baseline.
  addType(world, j, ['21000']);
  j.passed = true;
  const h = harness(world, j);
  await h.cleanup();
  assert.deepEqual(h.writes, ['DELETE /issuetype/30001', ...removeSpaces(j)]);
  assertSiteRestored(world, j);
  assertClean(h, j);
});

/** Steps mode configured: two new work types attached to the first space's scheme (Jira also put
 * one in the default scheme), each mapped to its own screen scheme of an edit and a view screen
 * that hold the field, an unused screen scheme, and the second space's default screens swapped
 * to the first new type's. */
function stepsRun() {
  const { world, j } = run();
  const [a, b] = j.fixtures.map((f) => f.key);
  const marker = `Setup run ${id} screen fixture.`;
  const tabs = (n, fields) => [{ id: 41000 + n, fields }];
  Object.assign(world.screens, {
    70000: { name: `${a}: Kanban Default Screen`, tabs: tabs(0, ['summary']) },
    70001: { name: `${b}: Kanban Default Screen`, tabs: tabs(1, ['summary']) },
  });
  Object.assign(world.screenSchemes, {
    60000: { name: `${a}: Kanban Screen Scheme`, screens: { default: 70000 } },
    60001: { name: `${b}: Kanban Screen Scheme`, screens: { default: 70001 } },
  });
  world.itss = {
    50000: { name: `${a}: Kanban Work Type Screen Scheme`, rows: { default: '60000' } },
    50001: { name: `${b}: Kanban Work Type Screen Scheme`, rows: { default: '60010' } },
  };
  const steps = {
    marker,
    itss: ['50000', '50001'],
    types: [0, 1].map((n) => ({ name: `Steps ${id} ${n}`, intent: true, id: String(30010 + n) })),
    screens: [0, 1, 2, 3].map((n) => ({
      name: `${a}: steps ${n >> 1} ${n % 2 ? 'view' : 'edit'}`,
      intent: true,
      id: String(70010 + n),
    })),
    schemes: [
      ...[0, 1].map((n) => ({ name: `${a}: steps ${n}`, intent: true, id: String(60010 + n) })),
      { name: `${a}: steps unused`, intent: true, id: '60012' },
    ],
    attachIntent: true,
    mappingIntent: true,
    defaultFrom: '60001',
    defaultIntent: true,
  };
  for (const x of steps.types) {
    world.types[x.id] = { name: x.name, description: marker, hierarchyLevel: 0, subtask: false };
    world.typeSchemes[21000].types.push(x.id);
  }
  world.typeSchemes[10000].types.push('30010');
  for (const [n, x] of steps.screens.entries())
    world.screens[x.id] = { name: x.name, description: marker, tabs: tabs(10 + n, [field]) };
  for (const [n, x] of steps.schemes.entries())
    world.screenSchemes[x.id] = {
      name: x.name,
      description: marker,
      screens:
        n < 2
          ? { default: 70010 + 2 * n, edit: 70010 + 2 * n, view: 70011 + 2 * n }
          : { default: 70010 },
    };
  Object.assign(world.itss[50000].rows, { 30010: '60010', 30011: '60011' });
  Object.assign(j, { field, steps, screens: steps.screens.map((x) => x.id) });
  return { world, j, steps };
}
const stepsDeletes = [
  ...['60010', '60011', '60012'].map((x) => `DELETE /screenscheme/${x}`),
  ...['70010', '70011', '70012', '70013'].map((x) => `DELETE /screens/${x}`),
  ...['30010', '30011'].flatMap((x) => [
    `DELETE /issuetypescheme/21000/issuetype/${x}`,
    `DELETE /issuetype/${x}`,
  ]),
];
// What Jira created with the two spaces, deleted after them.
const stepsLeftovers = [
  ...['50000', '50001'].map((x) => `DELETE /issuetypescreenscheme/${x}`),
  ...['60000', '60001'].map((x) => `DELETE /screenscheme/${x}`),
  ...['70000', '70001'].map((x) => `DELETE /screens/${x}`),
];
const assertNothingLeft = (world) => {
  assert.deepEqual(world.itss, {});
  assert.deepEqual(world.screenSchemes, {});
  assert.deepEqual(world.screens, {});
};

test('cleanup after steps mode stopped mid-removal undoes its fixtures in reverse', async () => {
  const { world, j, steps } = stepsRun();
  // The app had removed the field from the second type's screens only.
  for (const x of ['70012', '70013']) world.screens[x].tabs[0].fields = [];
  const h = harness(world, j);
  await h.cleanup();
  assert.deepEqual(h.writes, [
    `DELETE /screens/70010/tabs/41010/fields/${field}`,
    `DELETE /screens/70011/tabs/41011/fields/${field}`,
    'PUT /issuetypescreenscheme/50001/mapping/default {"screenSchemeId":"60001"}',
    'POST /issuetypescreenscheme/50000/mapping/remove {"issueTypeIds":["30010","30011"]}',
    ...stepsDeletes,
    ...removeSpaces(j),
    ...stepsLeftovers,
  ]);
  assert.equal(h.before[2].steps.restoreIntent, true);
  assert.equal(h.before[3].steps.unmapIntent, true);
  assert.equal(h.before[4].steps.schemes[0].deleteIntent, true);
  assert.equal(h.before[7].steps.screens[0].deleteIntent, true);
  assert.equal(h.before[11].steps.types[0].detachIntent, true);
  assert.equal(h.before[12].steps.types[0].deleteIntent, true);
  assert.equal(steps.defaultRestored, true);
  assert.ok([...steps.types, ...steps.screens, ...steps.schemes].every((x) => x.gone));
  assertNothingLeft(world);
  assertSiteRestored(world, j);
  assertClean(h, j);
});

test('steps cleanup finds a screen scheme whose creation response was lost', async () => {
  const { world, j, steps } = stepsRun();
  // Stopped while creating screen schemes: the second one exists but its id was never journaled.
  delete steps.schemes[1].id;
  steps.schemes.pop();
  delete world.screenSchemes[60012];
  for (const x of ['mappingIntent', 'defaultIntent', 'defaultFrom']) delete steps[x];
  world.itss[50000].rows = { default: '60000' };
  world.itss[50001].rows = { default: '60001' };
  for (const x of steps.screens) world.screens[x.id].tabs[0].fields = [];
  const h = harness(world, j);
  await h.cleanup();
  assert.equal(steps.schemes[1].id, '60011');
  assert.deepEqual(h.writes, [
    ...stepsDeletes.filter((x) => !x.endsWith('/60012')),
    ...removeSpaces(j),
    ...stepsLeftovers,
  ]);
  assert.ok(!h.calls.some((c) => c.includes('/issuetypescreenscheme/mapping')));
  assertSiteRestored(world, j);
  assertClean(h, j);
});

test('steps cleanup rerun after a lost delete response skips screens already gone', async () => {
  const { world, j, steps } = stepsRun();
  const first = harness(world, j, { lose: 'DELETE /issuetype/30010' });
  await assert.rejects(first.cleanup(), /response lost/);
  assert.equal(j.clean, false);
  assert.ok(steps.screens.every((x) => x.gone));
  // A deleted screen has no tabs to read; the field loop must not reach it.
  const rerun = harness(world, j);
  await rerun.cleanup();
  assert.ok(!rerun.calls.some((c) => c.startsWith('GET /screens/')));
  assert.deepEqual(rerun.writes, [
    'DELETE /issuetypescheme/21000/issuetype/30011',
    'DELETE /issuetype/30011',
    ...removeSpaces(j),
    ...stepsLeftovers,
  ]);
  assert.equal(steps.types[0].gone, true);
  assertSiteRestored(world, j);
  assertClean(rerun, j);
});

test('steps cleanup rerun after a failed screen delete reads that screen back by id only', async () => {
  // Regression: the field loop read the tabs of a screen whose delete response was lost.
  for (const failure of ['lose', 'drop']) {
    const { world, j, steps } = stepsRun();
    const first = harness(world, j, { [failure]: 'DELETE /screens/70011' });
    await assert.rejects(first.cleanup(), /Fixture API/, failure);
    assert.equal(steps.screens[1].deleteIntent, true, failure);
    assert.equal(steps.screens[1].gone, undefined, failure);
    assert.equal(!!world.screens[70011], failure === 'drop', failure);
    const rerun = harness(world, j);
    await rerun.cleanup();
    assert.ok(!rerun.calls.includes('GET /screens/70011/tabs'), failure);
    assert.ok(rerun.calls.includes('GET /screens?id=70011&startAt=0&maxResults=100'), failure);
    assert.deepEqual(
      rerun.writes,
      [
        ...(failure === 'drop' ? ['DELETE /screens/70011'] : []),
        ...stepsDeletes.slice(5),
        ...removeSpaces(j),
        ...stepsLeftovers,
      ],
      failure,
    );
    assertNothingLeft(world);
    assert.ok(
      steps.screens.every((x) => x.gone),
      failure,
    );
    assertSiteRestored(world, j);
    assertClean(rerun, j);
  }
});

test('cleanup stops without any write when the journal does not match the site', async () => {
  const unsafe = {
    'two work types with the run’s names': [
      (world, j) => {
        world.types[30001] = { name: j.typeName, description, hierarchyLevel: 0, subtask: false };
        world.types[30002] = { name: j.renamed, description, hierarchyLevel: 0, subtask: false };
        delete j.type;
      },
      /ambiguous/,
    ],
    'the work type in another space’s scheme': [
      (world) => world.typeSchemes[10100].types.push('30001'),
      /unexpected scheme association/,
    ],
    'a space without the run’s marker': [
      (world) => (world.projects[20001].description = 'Someone else’s space'),
      assert.AssertionError,
    ],
    'a space on a scheme the journal does not name': [
      (world) => (world.projects[20001].scheme = '10100'),
      assert.AssertionError,
    ],
  };
  for (const [name, [sabotage, expected]] of Object.entries(unsafe)) {
    const { world, j } = run();
    addType(world, j, ['21000', '21001']);
    sabotage(world, j);
    const h = harness(world, j);
    await assert.rejects(h.cleanup(), expected, name);
    assert.deepEqual(h.writes, [], name);
    assert.equal(j.clean, false, name);
  }
});
