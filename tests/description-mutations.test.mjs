import './support/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { createService } = await import('../src/service.ts');
const { JiraHttpError } = await import('../src/shared/jira.mjs');

// Seeded sweep of the edits people make to a work item's description in Jira while it has an
// Agent Prompts section: user content added, edited, moved and deleted around it; editor ids
// stamped; the section edited inside, retitled, moved, nested, duplicated, deleted or stripped of
// its id; other work items' sections and blocks of the user's own with the same title pasted in;
// the whole description rewritten; prompts deleted in Jira. After each round the user saves or
// syncs through the real service. Owner rule (2026-10-22, agent-prompts#bsqx): every save
// succeeds. It removes every Agent Prompts block, wherever it is and whatever it holds, writes one
// section with the linked prompts that still exist, and keeps everything else exactly as it was.
// Expected results come from this file's own model of the description, not from the service.
const c = { accountId: 'u', projectId: '1', issueId: '10' };
const FIELD = 'customfield_1';
const OWN = 'agent-prompts-10';
const SEEDS = 300;
const ROUNDS = 4;
const SOURCES = ['20', '21', '22', '23'];

const text = (t) => ({ type: 'text', text: t });
const paragraph = (t) => ({ type: 'paragraph', content: [text(t)] });
const heading = (t, level = 2) => ({ type: 'heading', attrs: { level }, content: [text(t)] });
const doc = (...content) => ({ type: 'doc', version: 1, content });

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

// An Agent Prompts block as the owner defined it: any expand titled Agent Prompts, whatever its
// case and spacing, or anything carrying an app section's identifier.
const block = (n) =>
  String(n.attrs?.localId ?? '').startsWith('agent-prompts-') ||
  ((n.type === 'expand' || n.type === 'nestedExpand') &&
    String(n.attrs?.title ?? '')
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .join(' ') === 'agent prompts');
/** The description with every block gone, and the top-level place of the first one (the place of
 * the top-level node that held it, when it was nested). A container left empty holds an empty
 * paragraph. */
function userContent(d) {
  let at;
  const strip = (nodes) =>
    nodes.flatMap((n) => {
      if (block(n)) return [];
      if (!n.content) return [n];
      const content = strip(n.content);
      return [
        { ...n, content: content.length || !n.content.length ? content : [{ type: 'paragraph' }] },
      ];
    });
  const content = [];
  for (const n of d?.content ?? []) {
    const kept = strip([n]);
    if (JSON.stringify(kept) !== JSON.stringify([n])) at ??= content.length;
    content.push(...kept);
  }
  return { content, at: at ?? content.length };
}
const blocksIn = (d) => {
  let count = 0;
  const visit = (n) => {
    if (block(n)) count++;
    n.content?.forEach(visit);
  };
  d?.content.forEach(visit);
  return count;
};

function world(seed) {
  const r = rng(seed);
  const pick = (list) => list[Math.floor(r() * list.length)];
  const hex = () => Math.floor(r() * 2 ** 48).toString(16);
  let serial = 0;
  const sources = Object.fromEntries(
    SOURCES.map((id) => [
      id,
      {
        id,
        key: `TEST-${id}`,
        fields: {
          project: { id: '1' },
          issuetype: { id: '3' },
          summary: `Prompt ${id}`,
          description: doc(paragraph(`Instructions ${id}`)),
          updated: '1',
        },
      },
    ]),
  );
  const userNode = () => {
    const n = ++serial;
    return pick([
      () => paragraph(`Note ${n}`),
      () => heading(`Plan ${n}`, 3),
      () => ({
        type: 'bulletList',
        content: [{ type: 'listItem', content: [paragraph(`Step ${n}`)] }],
      }),
      () => ({ type: 'expand', attrs: { title: 'Notes' }, content: [paragraph(`Aside ${n}`)] }),
      () => ({
        type: 'table',
        content: [
          { type: 'tableRow', content: [{ type: 'tableCell', content: [paragraph(`Cell ${n}`)] }] },
        ],
      }),
    ])();
  };
  const target = {
    id: '10',
    key: 'TEST-10',
    fields: {
      project: { id: '1' },
      issuetype: { id: '2' },
      summary: 'Work',
      updated: '1',
      description: doc(paragraph('Intro'), userNode(), paragraph('Details')),
    },
  };
  let stored;
  let writes = 0;
  const lookup = (id) => {
    if (id === '10' || id === 'TEST-10') return target;
    const source = sources[id] ?? Object.values(sources).find((s) => s.key === id);
    // Jira's answer for a work item that was deleted or never existed.
    if (!source) throw new JiraHttpError(404);
    return source;
  };
  const ports = {
    refreshAfterSave: async () => false,
    retainedTypes: async () => [],
    config: async () => '3',
    field: async () => FIELD,
    allowed: async () => {},
    search: async () => ({
      prompts: Object.values(sources).map((s) => ({
        id: s.id,
        key: s.key,
        name: s.fields.summary,
      })),
      incomplete: false,
    }),
    issue: async (id) => structuredClone(lookup(id)),
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
  /** A description edit in Jira: Jira bumps `updated` with it. */
  const edit = (change) => {
    const d = structuredClone(target.fields.description ?? doc());
    change(d);
    target.fields.description = d;
    target.fields.updated += 'e';
  };
  return {
    r,
    pick,
    hex,
    sources,
    target,
    userNode,
    edit,
    service: createService(ports),
    stored: () => structuredClone(stored),
    writes: () => writes,
  };
}

/** The section a save of `ids` must write, built from the prompts' current descriptions. */
const expectedSection = (w, ids) => ({
  type: 'expand',
  attrs: { localId: OWN, title: 'Agent Prompts' },
  content: ids.flatMap((id) => {
    const s = w.sources[id];
    return [
      heading(`${s.key}: ${s.fields.summary}`),
      ...structuredClone(s.fields.description.content),
    ];
  }),
});

const nest = (w, node) =>
  w.pick([
    () => ({
      type: 'layoutSection',
      content: [{ type: 'layoutColumn', attrs: { width: 100 }, content: [node] }],
    }),
    () => ({
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [{ type: 'tableCell', content: [{ ...node, type: 'nestedExpand' }] }],
        },
      ],
    }),
  ])();
const ownIndex = (d) => d.content.findIndex((n) => n.attrs?.localId === OWN);
const userIndexes = (d) => d.content.flatMap((n, i) => (block(n) ? [] : [i]));
const textsIn = (node) => {
  const found = [];
  const visit = (n) => {
    if (n.type === 'text') found.push(n);
    n.content?.forEach(visit);
  };
  visit(node);
  return found;
};
const otherSection = (w, nested) => {
  const keys = [...new Set([w.pick(SOURCES), w.pick(SOURCES)])].map((id) => `TEST-${id}`);
  if (w.r() < 0.2) keys.push(w.pick(['TEST-10', 'TEST-99']));
  const section = {
    type: 'expand',
    attrs: {
      ...(w.r() < 0.6 ? { localId: 'agent-prompts-99' } : {}),
      title: w.pick(['Agent Prompts', ' agent prompts ']),
    },
    content: keys.flatMap((key) => [heading(`${key}: Old`), paragraph(`Old copy of ${key}`)]),
  };
  return nested ? nest(w, section) : section;
};

// Each edit returns false when it doesn't apply to the current description.
const benign = {
  'add user content': (w, d) => {
    d.content.splice(Math.floor(w.r() * (d.content.length + 1)), 0, w.userNode());
  },
  'edit user text': (w, d) => {
    const texts = userIndexes(d).flatMap((i) => textsIn(d.content[i]));
    if (!texts.length) return false;
    w.pick(texts).text += ' (edited)';
  },
  'delete user content': (w, d) => {
    const at = userIndexes(d);
    if (!at.length) return false;
    d.content.splice(w.pick(at), 1);
  },
  'move user content': (w, d) => {
    const at = userIndexes(d);
    if (!at.length || d.content.length < 2) return false;
    const [node] = d.content.splice(w.pick(at), 1);
    d.content.splice(Math.floor(w.r() * (d.content.length + 1)), 0, node);
  },
  'editor stamps ids': (w, d) => {
    const visit = (n, top) => {
      if (n.type !== 'text' && !(top && n.attrs?.localId)) {
        n.attrs = { ...n.attrs };
        n.attrs.localId ??= w.hex();
      }
      n.content?.forEach((child) => visit(child, false));
    };
    d.content.forEach((n) => visit(n, true));
  },
  'move section': (w, d) => {
    const i = ownIndex(d);
    if (i < 0 || d.content.length < 2) return false;
    const [node] = d.content.splice(i, 1);
    d.content.splice(Math.floor(w.r() * (d.content.length + 1)), 0, node);
  },
};
const tampering = {
  'edit inside section': (w, d) => {
    const i = ownIndex(d);
    const texts = i < 0 ? [] : textsIn(d.content[i]);
    if (!texts.length) return false;
    w.pick(texts).text += ' (my change)';
  },
  'add note inside section': (w, d) => {
    const s = d.content[ownIndex(d)];
    if (!s) return false;
    s.content.splice(Math.floor(w.r() * (s.content.length + 1)), 0, paragraph('My note'));
  },
  'delete inside section': (w, d) => {
    const s = d.content[ownIndex(d)];
    if (!s || s.content.length < 2) return false;
    s.content.splice(Math.floor(w.r() * s.content.length), 1);
  },
  'retitle section': (w, d) => {
    const s = d.content[ownIndex(d)];
    if (!s) return false;
    s.attrs.title = w.pick(['Prompts', 'Agent prompts', 'Agent Prompts ']);
  },
  'strip section id': (w, d) => {
    const s = d.content[ownIndex(d)];
    if (!s) return false;
    delete s.attrs.localId;
  },
  'new section id': (w, d) => {
    const s = d.content[ownIndex(d)];
    if (!s) return false;
    s.attrs.localId = w.hex();
  },
  'duplicate section': (w, d) => {
    const s = d.content[ownIndex(d)];
    if (!s) return false;
    const copy = structuredClone(s);
    const id = w.pick(['same', 'none', 'new']);
    if (id === 'none') delete copy.attrs.localId;
    if (id === 'new') copy.attrs.localId = w.hex();
    d.content.splice(Math.floor(w.r() * (d.content.length + 1)), 0, copy);
  },
  'duplicate section nested': (w, d) => {
    const s = d.content[ownIndex(d)];
    if (!s) return false;
    d.content.splice(Math.floor(w.r() * (d.content.length + 1)), 0, nest(w, structuredClone(s)));
  },
  'nest section': (w, d) => {
    const i = ownIndex(d);
    if (i < 0) return false;
    d.content[i] = nest(w, d.content[i]);
  },
  'delete section': (w, d) => {
    const i = ownIndex(d);
    if (i < 0) return false;
    d.content.splice(i, 1);
  },
  'paste another section': (w, d) => {
    d.content.splice(Math.floor(w.r() * (d.content.length + 1)), 0, otherSection(w, w.r() < 0.3));
  },
  "add a block of the user's own with the title": (w, d) => {
    const block = {
      type: 'expand',
      attrs: { title: w.pick(['Agent Prompts', 'AGENT PROMPTS', ' agent  prompts ']) },
      content: [paragraph(`My own list ${w.hex()}`)],
    };
    d.content.splice(
      Math.floor(w.r() * (d.content.length + 1)),
      0,
      w.r() < 0.3 ? nest(w, block) : block,
    );
  },
  'rewrite the whole description': (w, d) => {
    d.content = [heading('Rewritten', 3), otherSection(w, false), paragraph('All new')];
  },
};

async function sweep(seed, stats) {
  const w = world(seed);
  const trace = [`seed ${seed}`];
  const fail = (message) => assert.fail(`${message}\n${trace.join('\n')}`);
  const count = (key) => (stats[key] = (stats[key] ?? 0) + 1);

  /** Opens the field, then saves `ids` (or syncs, with `sync`), checking the outcome. */
  async function save(ids, sync = false) {
    let loaded;
    try {
      loaded = await w.service.load(c);
    } catch (error) {
      fail(`The field did not open: ${error.message}`);
    }
    const linked = sync ? loaded.ids : ids;
    trace.push(`  ${sync ? 'sync' : 'save'} [${linked}]`);
    const before = structuredClone(w.target.fields.description);
    let result;
    try {
      result = await w.service.save(c, sync ? { sync: true } : { ids, revision: loaded.revision });
    } catch (error) {
      fail(`A ${sync ? 'Sync' : 'save'} was refused: ${error.message}`);
    }
    const existing = linked.filter((id) => w.sources[id]);
    const gone = linked.filter((id) => !w.sources[id]);
    assert.deepEqual(result.ids, existing, trace.join('\n'));
    assert.deepEqual(
      result.dropped ?? [],
      // A prompt Jira can't find is named by the key it was saved with.
      gone.map((id) => (loaded.ids.includes(id) ? `TEST-${id}` : `the prompt with ID ${id}`)),
      trace.join('\n'),
    );
    if (gone.length) count('dropped deleted prompts');
    const after = w.target.fields.description;
    const expected = userContent(before);
    if (existing.length) expected.content.splice(expected.at, 0, expectedSection(w, existing));
    assert.deepEqual(
      after?.content ?? [],
      expected.content,
      `The save lost, changed or misplaced content.\n${trace.join('\n')}`,
    );
    assert.equal(blocksIn(after), existing.length ? 1 : 0, trace.join('\n'));
    assert.deepEqual(
      w.target.fields[FIELD] ?? [],
      existing.map((id) => `TEST-${id}`),
    );
    count(existing.length ? (sync ? 'synced' : 'saved') : 'removed');
    return existing;
  }

  // A work item that already uses some prompts.
  let selected = SOURCES.filter(() => w.r() < 0.5).slice(0, 3);
  if (!selected.length) selected = [w.pick(SOURCES)];
  trace.push('start');
  selected = await save(selected);

  for (let round = 0; round < ROUNDS; round++) {
    const made = [];
    for (let k = 1 + Math.floor(w.r() * 3); k > 0; k--) {
      const [name, change] = w.pick(Object.entries(w.r() < 0.5 ? benign : tampering));
      let applied = true;
      w.edit((d) => {
        applied = change(w, d) !== false;
      });
      if (applied) made.push(name);
    }
    if (w.r() < 0.15) {
      // Bulk edit, automation or REST changes the field itself.
      w.target.fields[FIELD] = w.pick([[], ['TEST-21'], ['TEST-99', 'TEST-20']]);
      w.target.fields.updated += 'f';
      made.push('field edited in Jira');
    }
    if (w.r() < 0.3) {
      const id = w.pick(SOURCES);
      if (w.sources[id]) {
        w.sources[id].fields.description = doc(paragraph(`Instructions ${id} v${round}`));
        made.push('a prompt rewritten');
      }
    }
    if (w.r() < 0.15 && selected.length) {
      delete w.sources[w.pick(selected)];
      made.push('a linked prompt deleted');
    }
    trace.push(`round ${round}: ${made.join(', ') || 'no edit'}`);
    made.forEach((m) => count(`edit: ${m}`));
    const remaining = SOURCES.filter((id) => w.sources[id]);
    const choice = w.r();
    if (choice < 0.45 && selected.length) selected = await save([], true);
    else
      selected = await save(
        choice < 0.6
          ? []
          : choice < 0.8
            ? selected
            : remaining.filter(() => w.r() < 0.5).slice(0, 5),
      );
  }
}

test("every description edit is put right by the next Save or Sync, keeping the user's content", async () => {
  const stats = {};
  for (let seed = 1; seed <= SEEDS; seed++) await sweep(seed, stats);
  // The sweep must keep reaching every edit and outcome.
  for (const name of [...Object.keys(benign), ...Object.keys(tampering)])
    assert.ok(stats[`edit: ${name}`] >= 20, `${name}: ${stats[`edit: ${name}`] ?? 0}`);
  for (const outcome of [
    'saved',
    'synced',
    'removed',
    'dropped deleted prompts',
    'edit: a linked prompt deleted',
  ])
    assert.ok(stats[outcome] >= 20, `${outcome}: ${stats[outcome] ?? 0}`);
});
