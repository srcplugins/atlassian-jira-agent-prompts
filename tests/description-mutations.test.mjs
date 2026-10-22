import './support/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { createService, UserError, hash } = await import('../src/service.ts');
const { DescriptionError } = await import('../src/description.ts');

// Seeded sweep of the edits people make to a work item's description in Jira while it has an
// Agent Prompts section: user content added, edited, moved and deleted around it; editor ids
// stamped; the section edited inside, retitled, moved, nested, duplicated, deleted or stripped of
// its id; and other work items' sections pasted in. After each round the user saves through the
// real service. Every save must either keep everything the user wrote (dropping only the section
// exactly as the app wrote it, or the one section the user chose to replace) or be refused without
// a write, with a message from a known set whose steps, followed as a user would, lead back to a
// working field. Expected results come from this file's own model of the description, not from the
// service's checks.
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

// The refusals a description edit may cause, and nothing else.
const CHANGED =
  /^The Agent Prompts section was changed, moved or duplicated in Jira\. Undo that change, or delete the section from the description, remove all prompts here and save, then add them again\.$/;
const REMOVED =
  /^The Agent Prompts section was removed in Jira\. Remove all prompts and save, then add them again\.$/;
const OTHER =
  /^The description has an Agent Prompts section the app didn't save\. Delete it from the description, or use its prompts here to replace it, then save again\.$/;
const REOPEN =
  /^The other Agent Prompts section changed in the description\. Reopen the field and try again\.$/;
const REFUSALS = { changed: CHANGED, removed: REMOVED, other: OTHER, reopen: REOPEN };

// An Agent Prompts section as the spec defines one: an expand carrying the app's identifier, or
// titled Agent Prompts and listing prompts by their headings. Everything else in the description
// is the user's, including a copy they both retitled and pasted without its identifier.
const promptHeading = (n) =>
  n.type === 'heading' && /^TEST-\d+: /.test((n.content ?? []).map((t) => t.text ?? '').join(''));
const sectionLike = (n) =>
  (n.type === 'expand' || n.type === 'nestedExpand') &&
  (String(n.attrs?.localId ?? '').startsWith('agent-prompts-') ||
    (String(n.attrs?.title ?? '')
      .trim()
      .toLowerCase() === 'agent prompts' &&
      (n.content ?? []).some(promptHeading)));
/** A copy without the ids editors stamp on nodes inside a section. */
const unstamped = (n) => {
  const copy = { ...n };
  if (copy.attrs && 'localId' in copy.attrs) {
    const rest = { ...copy.attrs };
    delete rest.localId;
    if (Object.keys(rest).length) copy.attrs = rest;
    else delete copy.attrs;
  }
  if (n.content) copy.content = n.content.map(unstamped);
  return copy;
};
/** The section exactly as the app last wrote it, give or take editor ids inside. */
const pristine = (n, last) =>
  !!last &&
  n.type === 'expand' &&
  JSON.stringify(n.attrs) === JSON.stringify(last.attrs) &&
  JSON.stringify((n.content ?? []).map(unstamped)) === JSON.stringify(last.content);
const idCount = (d, id) => {
  let count = 0;
  const visit = (n) => {
    if (n.attrs?.localId === id) count++;
    n.content?.forEach(visit);
  };
  d?.content.forEach(visit);
  return count;
};
/** Removes nodes matching `drop` at any depth. */
const without = (nodes, drop) =>
  nodes
    .filter((n) => !drop(n))
    .map((n) => (n.content ? { ...n, content: without(n.content, drop) } : n));

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
      // A user's own expand with the app's title but no prompt headings is still theirs.
      () => ({
        type: 'expand',
        attrs: { title: 'Agent Prompts' },
        content: [paragraph(`My own list ${n}`)],
      }),
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
    if (!source) throw new UserError('Not found.');
    return source;
  };
  const ports = {
    refreshAfterSave: async () => false,
    retainedTypes: async () => [],
    config: async () => '3',
    field: async () => FIELD,
    allowed: async () => {},
    search: async () => ({
      prompts: SOURCES.map((id) => ({
        id,
        key: sources[id].key,
        name: sources[id].fields.summary,
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
const userIndexes = (d) => d.content.flatMap((n, i) => (sectionLike(n) ? [] : [i]));
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
};

async function sweep(seed, stats) {
  const w = world(seed);
  const trace = [`seed ${seed}`];
  const fail = (message) => assert.fail(`${message}\n${trace.join('\n')}`);
  const count = (key) => (stats[key] = (stats[key] ?? 0) + 1);
  let last = null; // The section as the app last wrote it.

  /** Opens the field and saves `choose(loaded)`, checking the outcome against the model. */
  async function attempt(choose) {
    let loaded;
    try {
      loaded = await w.service.load(c);
    } catch (error) {
      fail(`The field did not open: ${error.message}`);
    }
    const { ids, replace } = choose(loaded);
    trace.push(`  save [${ids}]${replace ? ' replacing the other section' : ''}`);
    const before = structuredClone(w.target.fields.description);
    const field = structuredClone(w.target.fields[FIELD]);
    const stored = w.stored();
    const writes = w.writes();
    try {
      await w.service.save(c, {
        ids,
        revision: loaded.revision,
        fingerprint: loaded.fingerprint,
        ...(replace ? { replace } : {}),
      });
    } catch (error) {
      // Both reach the user as the field's message (integration.ts).
      if (!(error instanceof UserError || error instanceof DescriptionError)) throw error;
      trace.push(`  refused: ${error.message}`);
      const kind = Object.entries(REFUSALS).find(([, m]) => m.test(error.message))?.[0];
      if (!kind) fail(`Unexpected refusal: ${error.message}`);
      assert.equal(w.writes(), writes, `A refused save wrote to Jira.\n${trace.join('\n')}`);
      assert.deepEqual(w.target.fields.description, before);
      assert.deepEqual(w.target.fields[FIELD], field);
      assert.deepEqual(w.stored(), stored, `A refused save changed storage.\n${trace.join('\n')}`);
      count(`refused: ${kind}`);
      return { ok: false, message: error.message, loaded };
    }
    const after = w.target.fields.description;
    // The app's own section holds exactly the chosen prompts, once, at the top level.
    if (ids.length) {
      if (idCount(after, OWN) !== 1)
        fail('The saved description does not have exactly one section.');
      assert.deepEqual(
        after.content.find((n) => n.attrs?.localId === OWN),
        expectedSection(w, ids),
        trace.join('\n'),
      );
      // The app never writes its section beside another one.
      const sections = [];
      const visit = (n) => (sectionLike(n) ? sections.push(n) : n.content?.forEach(visit));
      after.content.forEach(visit);
      if (sections.length !== 1) fail('The app saved its section beside another one.');
    } else if (idCount(after, OWN)) fail('A removal left a node with the section id.');
    assert.deepEqual(
      w.target.fields[FIELD],
      ids.map((id) => `TEST-${id}`),
    );
    // Everything else is the user's and must be kept verbatim, in order. The save may drop only
    // the app's section as it wrote it, and the one section the user named to replace.
    let droppedOwn = false;
    let droppedOther = false;
    const kept = (before?.content ?? []).filter((n) => {
      if (!droppedOwn && pristine(n, last)) return !(droppedOwn = true);
      if (replace && !droppedOther && hash(n) === replace) {
        if (!sectionLike(n)) fail('The save replaced user content.');
        return !(droppedOther = true);
      }
      return true;
    });
    assert.deepEqual(
      (after?.content ?? []).filter((n) => n.attrs?.localId !== OWN),
      kept,
      `The save lost or changed user content.\n${trace.join('\n')}`,
    );
    last = ids.length ? expectedSection(w, ids) : null;
    count(ids.length ? 'saved' : 'removed');
    return { ok: true };
  }
  const save = (ids, replace) => attempt(() => ({ ids, replace }));

  // A work item that already uses some prompts.
  let selected = SOURCES.filter(() => w.r() < 0.5).slice(0, 3);
  if (!selected.length) selected = [w.pick(SOURCES)];
  trace.push('start');
  if (!(await save(selected)).ok) fail('The first save was refused.');

  for (let round = 0; round < ROUNDS; round++) {
    const start = structuredClone(w.target.fields.description);
    // Only the app's own section, unchanged: every edit a user makes around it must save.
    const clean = (() => {
      const found = [];
      const visit = (n) => {
        if (sectionLike(n)) found.push(n);
        else n.content?.forEach(visit);
      };
      start?.content.forEach(visit);
      return found.every((n) => start.content.includes(n) && pristine(n, last));
    })();
    const made = [];
    for (let k = 1 + Math.floor(w.r() * 3); k > 0; k--) {
      const harmless = w.r() < 0.5;
      const [name, change] = w.pick(Object.entries(harmless ? benign : tampering));
      let applied = true;
      w.edit((d) => {
        applied = change(w, d) !== false;
      });
      if (applied) made.push({ name, harmless });
    }
    if (w.r() < 0.15) {
      // Bulk edit, automation or REST changes the field itself.
      w.target.fields[FIELD] = w.pick([[], ['TEST-21'], ['TEST-99', 'TEST-20']]);
      w.target.fields.updated += 'f';
      made.push({ name: 'field edited in Jira', harmless: false });
    }
    if (w.r() < 0.3) {
      const id = w.pick(SOURCES);
      w.sources[id].fields.description = doc(paragraph(`Instructions ${id} v${round}`));
      made.push({ name: `prompt ${id} rewritten`, harmless: true });
    }
    let desired = w.pick([
      () => selected,
      () => [],
      () => SOURCES.filter(() => w.r() < 0.5).slice(0, 5),
    ])();
    trace.push(`round ${round}: ${made.map((m) => m.name).join(', ') || 'no edit'}`);
    made.forEach((m) => count(`edit: ${m.name}`));

    let result = await save(desired);
    if (!result.ok && clean && made.every((m) => m.harmless))
      fail('A save was refused after edits that leave the section as the app wrote it.');
    // Follow the refusal's own steps, as a user would, until the field saves.
    let undoable = true;
    for (let steps = 0; !result.ok; steps++) {
      if (steps > 8) fail('The steps in the messages did not lead back to a working field.');
      const { message, loaded } = result;
      if (CHANGED.test(message) && undoable && w.r() < 0.4) {
        trace.push('  user undoes the edits');
        count('recovery: undo');
        w.edit((d) => Object.assign(d, structuredClone(start)));
        result = await save(desired);
      } else if (CHANGED.test(message) || REMOVED.test(message)) {
        if (CHANGED.test(message)) {
          // The user deletes what they see as the section: every copy, or just some of them.
          const all = w.r() < 0.6;
          trace.push(`  user deletes ${all ? 'every section' : 'some sections'}`);
          count('recovery: delete sections');
          w.edit((d) => {
            d.content = without(d.content, (n) => sectionLike(n) && (all || w.r() < 0.5));
          });
        }
        count('recovery: remove all, then add again');
        result = await save([]);
        if (result.ok) result = await save(desired);
      } else if (OTHER.test(message)) {
        const other = loaded.otherSection;
        const use = [...new Set([...desired, ...(other?.prompts ?? []).map((p) => p.id)])].slice(
          0,
          5,
        );
        if (other?.replace && use.length && w.r() < 0.5) {
          trace.push('  user uses its prompts');
          count('recovery: replace');
          desired = use;
          result = await save(desired, other.replace);
        } else {
          trace.push('  user deletes the other sections');
          count('recovery: delete other sections');
          w.edit((d) => {
            d.content = without(
              d.content,
              (n) => sectionLike(n) && !(d.content.includes(n) && pristine(n, last)),
            );
          });
          result = await save(desired);
        }
      } else {
        count('recovery: reopen');
        result = await save(desired);
      }
      undoable = false;
    }
    selected = desired.length ? desired : [w.pick(SOURCES)];
    if (!desired.length) {
      // The field works again: adding prompts back must save too.
      trace.push('  add prompts back');
      const again = await save(selected);
      if (!again.ok && !OTHER.test(again.message)) fail('Prompts could not be added back.');
      if (!again.ok) {
        w.edit((d) => {
          d.content = without(d.content, sectionLike);
        });
        if (!(await save(selected)).ok) fail('Prompts could not be added back.');
      }
    }
  }
}

test('every description edit either saves without losing user content or is refused with steps that work', async () => {
  const stats = {};
  for (let seed = 1; seed <= SEEDS; seed++) await sweep(seed, stats);
  // The sweep must keep reaching every edit, refusal and recovery path.
  for (const name of [...Object.keys(benign), ...Object.keys(tampering)])
    assert.ok(stats[`edit: ${name}`] >= 20, `${name}: ${stats[`edit: ${name}`] ?? 0}`);
  for (const path of [
    'recovery: undo',
    'recovery: delete sections',
    'recovery: remove all, then add again',
    'recovery: replace',
    'recovery: delete other sections',
  ])
    assert.ok(stats[path] >= 10, `${path}: ${stats[path] ?? 0}`);
  for (const kind of ['changed', 'removed', 'other'])
    assert.ok(
      stats[`refused: ${kind}`] >= 10,
      `refused ${kind}: ${stats[`refused: ${kind}`] ?? 0}`,
    );
});
