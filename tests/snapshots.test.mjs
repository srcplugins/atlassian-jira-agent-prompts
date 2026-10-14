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
test('save, ordered Sync and removal preserve unrelated rich ADF and input objects', () => {
  const original = doc(
    { type: 'table', attrs: { layout: 'wide' }, content: [] },
    { type: 'expand', attrs: { title: 'Agent Prompts' }, content: [paragraph('User-owned')] },
    { type: 'extension', attrs: { custom: 'untouched' } },
  );
  const baseline = structuredClone(original);
  const added = synchronizeDescription(original, [p], null, 'npl-10');
  assert.deepEqual(original, baseline);
  assert.deepEqual(added.description.content.slice(0, 3), original.content);
  const second = { id: '21', name: 'Second', content: [paragraph('Different instructions')] };
  const refreshed = synchronizeDescription(added.description, [second, p], added.managed, 'npl-10');
  assert.equal(refreshed.description.content[3].content[0].content[0].text, 'Second');
  assert.equal(refreshed.description.content[3].content[2].content[0].text, p.name);
  assert.deepEqual(
    synchronizeDescription(refreshed.description, [], refreshed.managed, 'npl-10').description,
    original,
  );
});
test('changed, missing, duplicate, nested and untracked expanders stop writes', () => {
  const added = synchronizeDescription(doc(), [p], null, 'npl-10');
  for (const mode of ['changed', 'missing', 'duplicate', 'nested', 'untracked']) {
    const d = structuredClone(added.description);
    const n = d.content[0];
    if (mode === 'changed') n.content[1] = paragraph('Manual override');
    if (mode === 'missing') d.content = [];
    if (mode === 'duplicate') d.content.push(structuredClone(n));
    if (mode === 'nested') d.content = [{ type: 'expand', content: [n] }];
    assert.throws(() =>
      synchronizeDescription(d, [p], mode === 'untracked' ? null : added.managed, 'npl-10'),
    );
  }
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

test('a deleted tracked block is forgotten only for an empty selection', () => {
  const saved = synchronizeDescription(doc(paragraph('Intro')), [p], null, 'npl-10');
  const removed = doc(paragraph('Intro'));
  assert.deepEqual(synchronizeDescription(removed, [], saved.managed, 'npl-10'), {
    description: removed,
    managed: null,
    shape: null,
    forgotten: true,
  });
  assert.throws(
    () => synchronizeDescription(removed, [p], saved.managed, 'npl-10'),
    /section was removed in Jira/,
  );
  // An untracked container with our identifier still blocks, even when forgetting.
  const lookalike = doc({
    type: 'expand',
    attrs: { localId: 'npl-10', title: 'Agent Prompts' },
    content: [paragraph('Mine')],
  });
  const moved = doc(paragraph('Intro'), { type: 'blockquote', content: [lookalike.content[0]] });
  assert.throws(
    () => synchronizeDescription(moved, [], saved.managed, 'npl-10'),
    /changed, moved or duplicated|untracked/,
  );
  // A changed block is not "deleted": empty selection still refuses.
  const changed = structuredClone(saved.description);
  changed.content[1].content[1].content[0].text = 'Edited';
  assert.throws(
    () => synchronizeDescription(changed, [], saved.managed, 'npl-10'),
    /changed, moved or duplicated/,
  );
});
