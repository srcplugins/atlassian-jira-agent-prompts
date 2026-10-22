import './support/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { snapshotContent, synchronizeDescription } = await import('../src/description.ts');
const paragraph = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const doc = (...content) => ({ type: 'doc', version: 1, content });
const p = { id: '20', name: 'TEST-20: Review', content: [paragraph('Check errors')] };
test('ordinary source instructions are copied; empty and embedded content fail', () => {
  assert.deepEqual(snapshotContent(doc(...p.content)), p.content);
  for (const d of [
    null,
    doc(),
    doc({ type: 'syncBlock' }),
    doc({ type: 'bodiedSyncBlock', content: p.content }),
    doc({ type: 'mediaSingle' }),
  ])
    assert.throws(() => snapshotContent(d));
});
const own = (...prompts) => ({
  type: 'expand',
  attrs: { localId: 'agent-prompts-10', title: 'Agent Prompts' },
  content: prompts.flatMap((prompt) => [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: prompt.name }] },
    ...prompt.content,
  ]),
});
const heading = (text) => ({
  type: 'heading',
  attrs: { level: 2 },
  content: [{ type: 'text', text }],
});
const sync = (d, prompts = [p]) => synchronizeDescription(d, prompts, 'agent-prompts-10');
test('save, ordered Sync and removal preserve unrelated rich ADF and input objects', () => {
  const original = doc(
    { type: 'table', attrs: { layout: 'wide' }, content: [] },
    { type: 'expand', attrs: { title: 'My notes' }, content: [paragraph('User-owned')] },
    { type: 'extension', attrs: { custom: 'untouched' } },
  );
  const baseline = structuredClone(original);
  const added = sync(original);
  assert.deepEqual(original, baseline);
  assert.deepEqual(added, doc(...original.content, own(p)));
  const second = { id: '21', name: 'Second', content: [paragraph('Different instructions')] };
  const refreshed = sync(added, [second, p]);
  assert.deepEqual(refreshed, doc(...original.content, own(second, p)));
  assert.deepEqual(sync(refreshed, []), original);
  // Nothing to write and nothing to remove: an empty description stays empty.
  assert.equal(sync(null, []), null);
  assert.deepEqual(sync(null), doc(own(p)));
  assert.deepEqual(sync(doc(), []), doc());
});
// Owner decisions 2026-10-22 (agent-prompts#bsqx): whatever anyone did to the section, or however
// many Agent Prompts blocks the description holds, Save and Sync remove them all and write one
// section from the linked prompts. Everything else stays exactly as it is.
test('every Agent Prompts block is removed and one current section is written', () => {
  const intro = paragraph('Intro');
  const outro = paragraph('Outro');
  const saved = sync(doc(intro, outro));
  assert.deepEqual(saved, doc(intro, outro, own(p)));
  const section = saved.content[2];
  const edit = (change) => {
    const d = structuredClone(saved);
    change(d, d.content[2]);
    return d;
  };
  const cases = {
    'edited text': edit((_, n) => (n.content[1].content[0].text = 'Poopteam name')),
    'a paragraph typed inside': edit((_, n) => n.content.push(paragraph('Typed in Jira'))),
    retitled: edit((_, n) => (n.attrs.title = 'Prompts for agents')),
    "Jira's editor ids": edit((_, n) =>
      n.content.forEach((child, i) => (child.attrs = { ...child.attrs, localId: `e${i}` })),
    ),
    'its identifier dropped': edit((_, n) => (n.attrs = { title: 'Agent Prompts' })),
    duplicated: edit((d) => d.content.unshift(structuredClone(section))),
    'fake keys': edit((_, n) => (n.content = [heading('NOPE-404: Never existed'), paragraph('x')])),
    'a hand-added prompt': edit((_, n) =>
      n.content.push(heading('TEST-99: Added by hand'), paragraph('Do this too')),
    ),
    'pasted from another work item': edit((d) =>
      d.content.push({
        ...structuredClone(section),
        attrs: { localId: 'agent-prompts-77', title: 'Agent Prompts' },
      }),
    ),
    "a user's own block with the title": edit((d) =>
      d.content.push({
        type: 'expand',
        attrs: { title: ' agent  PROMPTS ' },
        content: [paragraph('Mine')],
      }),
    ),
    '100 blocks': edit((d) => {
      for (let i = 0; i < 99; i++)
        d.content.push({
          type: 'expand',
          attrs: { title: 'Agent Prompts' },
          content: [paragraph(`${i}`)],
        });
    }),
  };
  for (const [name, d] of Object.entries(cases)) {
    const before = structuredClone(d);
    const result = sync(d);
    assert.deepEqual(d, before, name);
    assert.deepEqual(
      result,
      doc(...(name === 'duplicated' ? [own(p), intro, outro] : [intro, outro, own(p)])),
      name,
    );
  }
  // Removing the prompts removes every block too.
  for (const [name, d] of Object.entries(cases))
    assert.deepEqual(sync(d, []), doc(intro, outro), name);
});
test('the section takes the place of the first block, or of the node that held it, or goes last', () => {
  const block = (text) => ({
    type: 'expand',
    attrs: { title: 'Agent Prompts' },
    content: [paragraph(text)],
  });
  const a = paragraph('A');
  const b = paragraph('B');
  assert.deepEqual(sync(doc(a, block('old'), b, block('older'))), doc(a, own(p), b));
  assert.deepEqual(sync(doc(a, b)), doc(a, b, own(p)));
  // Nested: the nested block goes, its container stays and gets an empty paragraph if nothing is
  // left in it, and the section goes before that container at the top level.
  const nested = {
    type: 'nestedExpand',
    attrs: { title: 'Agent Prompts' },
    content: [paragraph('n')],
  };
  const cell = (...content) => ({ type: 'tableCell', content });
  const table = (...cells) => ({ type: 'table', content: [{ type: 'tableRow', content: cells }] });
  assert.deepEqual(
    sync(doc(a, table(cell(nested), cell(b)), block('later'))),
    doc(a, own(p), table(cell({ type: 'paragraph' }), cell(b))),
  );
  const users = (...content) => ({ type: 'expand', attrs: { title: 'Mine' }, content });
  assert.deepEqual(sync(doc(users(a, nested))), doc(own(p), users(a)));
  // A block with the app's identifier counts wherever it is and whatever its type.
  const moved = {
    type: 'panel',
    attrs: { localId: 'agent-prompts-10' },
    content: [paragraph('m')],
  };
  assert.deepEqual(
    sync(doc(a, { type: 'layoutColumn', content: [moved] })),
    doc(a, own(p), { type: 'layoutColumn', content: [{ type: 'paragraph' }] }),
  );
  // Other titles are the user's.
  const notOurs = { type: 'expand', attrs: { title: 'Agent Prompts (old)' }, content: [b] };
  assert.deepEqual(sync(doc(notOurs)), doc(notOurs, own(p)));
});
test('a whole description rewritten in Jira still syncs to one current section', () => {
  const rewritten = doc(
    heading('Rewritten'),
    {
      type: 'expand',
      attrs: { localId: 'ab12', title: 'Agent Prompts' },
      content: [paragraph('Pasted over')],
    },
    paragraph('All new text'),
  );
  assert.deepEqual(sync(rewritten), doc(heading('Rewritten'), own(p), paragraph('All new text')));
});
test('snapshot copies preserve meaningful formatting but remove copied editor identifiers', () => {
  const source = doc({
    type: 'paragraph',
    attrs: { localId: 'source' },
    content: [
      {
        type: 'text',
        text: 'Policy',
        marks: [{ type: 'link', attrs: { href: 'https://example.com/policy' } }],
      },
    ],
  });
  const copy = snapshotContent(source);
  assert.equal(copy[0].attrs, undefined);
  assert.deepEqual(copy[0].content, source.content[0].content);
  assert.equal(source.content[0].attrs.localId, 'source');
});

test('copied formatting is limited to reviewed marks; comment anchors are dropped', () => {
  const text = (marks) =>
    doc({ type: 'paragraph', content: [{ type: 'text', text: 'Do this', marks }] });
  const kept = [
    { type: 'strong' },
    { type: 'strike' },
    { type: 'link', attrs: { href: 'https://example.com/guide' } },
    { type: 'link', attrs: { href: 'mailto:team@example.com' } },
    { type: 'textColor', attrs: { color: '#ff5630' } },
  ];
  assert.deepEqual(snapshotContent(text(kept))[0].content[0].marks, kept);
  const anchored = snapshotContent(
    text([{ type: 'annotation', attrs: { id: 'c1' } }, { type: 'em' }]),
  );
  assert.deepEqual(anchored[0].content[0].marks, [{ type: 'em' }]);
  const onlyAnchor = snapshotContent(text([{ type: 'annotation', attrs: { id: 'c1' } }]));
  assert.equal('marks' in onlyAnchor[0].content[0], false);
  for (const href of ['javascript:alert(1)', 'data:text/html,x', '//example.com', ''])
    assert.throws(
      () => snapshotContent(text([{ type: 'link', attrs: { href } }])),
      /http, https or mailto/,
    );
  assert.throws(
    () => snapshotContent(text([{ type: 'unknownMark' }])),
    /formatting that cannot be copied/,
  );
  // Block-level marks are limited to layout.
  assert.doesNotThrow(() =>
    snapshotContent(
      doc({ ...paragraph('Centered'), marks: [{ type: 'alignment', attrs: { align: 'center' } }] }),
    ),
  );
  assert.throws(
    () =>
      snapshotContent(
        doc({
          ...paragraph('Linked block'),
          marks: [{ type: 'link', attrs: { href: 'https://x' } }],
        }),
      ),
    /cannot be copied/,
  );
});

test('prompt text is bounded at 4,000 characters inclusive', () => {
  assert.doesNotThrow(() => snapshotContent(doc(paragraph('x'.repeat(4000)))));
  assert.throws(() => snapshotContent(doc(paragraph('x'.repeat(4001)))), /1–4000/);
  // An emoji is one character, though JavaScript stores it as two code units.
  assert.doesNotThrow(() => snapshotContent(doc(paragraph('😀'.repeat(4000)))));
  assert.throws(() => snapshotContent(doc(paragraph('😀'.repeat(4001)))), /1–4000/);
  assert.throws(
    () => snapshotContent(doc(paragraph('x'.repeat(2000)), paragraph('y'.repeat(2001)))),
    /1–4000/,
  );
});
