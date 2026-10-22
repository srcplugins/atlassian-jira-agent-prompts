import './support/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { snapshotContent, synchronizeDescription, otherSections, hash } =
  await import('../src/description.ts');
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
  const added = synchronizeDescription(original, [p], null, 'agent-prompts-10');
  assert.deepEqual(original, baseline);
  assert.deepEqual(added.description.content.slice(0, 3), original.content);
  const second = { id: '21', name: 'Second', content: [paragraph('Different instructions')] };
  const refreshed = synchronizeDescription(
    added.description,
    [second, p],
    added.managed,
    'agent-prompts-10',
  );
  assert.equal(refreshed.description.content[3].content[0].content[0].text, 'Second');
  assert.equal(refreshed.description.content[3].content[2].content[0].text, p.name);
  assert.deepEqual(
    synchronizeDescription(refreshed.description, [], refreshed.managed, 'agent-prompts-10')
      .description,
    original,
  );
});
test('changed, missing, duplicate, nested and untracked expanders stop writes', () => {
  const added = synchronizeDescription(doc(), [p], null, 'agent-prompts-10');
  for (const mode of ['changed', 'missing', 'duplicate', 'nested', 'untracked']) {
    const d = structuredClone(added.description);
    const n = d.content[0];
    if (mode === 'changed') n.content[1] = paragraph('Manual override');
    if (mode === 'missing') d.content = [];
    if (mode === 'duplicate') d.content.push(structuredClone(n));
    if (mode === 'nested') d.content = [{ type: 'expand', content: [n] }];
    assert.throws(() =>
      synchronizeDescription(
        d,
        [p],
        mode === 'untracked' ? null : added.managed,
        'agent-prompts-10',
      ),
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

// Jira's editors, the mobile one included, stamp their own localId on every node of a description
// they save (seen on a real work item, 2026-10-21). That is not an edit to the section: Sync,
// replacement and removal keep working. Instructions edited in Jira still refuse.
test("Jira's editor identifiers inside the section don't make it changed", () => {
  const list = {
    type: 'bulletList',
    content: [{ type: 'listItem', content: [paragraph('team name')] }],
  };
  const source = { id: '21', name: 'TEST-21: Intake', content: [paragraph('Validate'), list] };
  const saved = synchronizeDescription(
    doc(paragraph('Intro')),
    [p, source],
    null,
    'agent-prompts-10',
  );
  let n = 0;
  const stamp = (node, top) => {
    if (!top) node.attrs = { ...node.attrs, localId: `e${(n++).toString(16).padStart(11, '0')}` };
    node.content?.forEach((child) => stamp(child, false));
  };
  const stamped = structuredClone(saved.description);
  stamp(stamped.content[1], true);
  // Sync with the same prompts, a replacement and removal all accept the stamped section.
  const synced = synchronizeDescription(stamped, [p, source], saved.managed, 'agent-prompts-10');
  assert.deepEqual(synced.description.content[0], paragraph('Intro'));
  assert.equal(synced.description.content.length, 2);
  assert.doesNotThrow(() =>
    synchronizeDescription(stamped, [source], saved.managed, 'agent-prompts-10'),
  );
  assert.deepEqual(
    synchronizeDescription(stamped, [], saved.managed, 'agent-prompts-10').description,
    doc(paragraph('Intro')),
  );
  // Stamped and then edited is still an edit.
  const edited = structuredClone(stamped);
  edited.content[1].content[1].content[0].text = 'Edited';
  assert.throws(
    () => synchronizeDescription(edited, [p, source], saved.managed, 'agent-prompts-10'),
    /changed, moved or duplicated/,
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
  const saved = synchronizeDescription(doc(paragraph('Intro')), [p], null, 'agent-prompts-10');
  const removed = doc(paragraph('Intro'));
  assert.deepEqual(synchronizeDescription(removed, [], saved.managed, 'agent-prompts-10'), {
    description: removed,
    managed: null,
    shape: null,
    forgotten: true,
  });
  assert.throws(
    () => synchronizeDescription(removed, [p], saved.managed, 'agent-prompts-10'),
    /section was removed in Jira/,
  );
  // An untracked container with our identifier still blocks, even when forgetting.
  const lookalike = doc({
    type: 'expand',
    attrs: { localId: 'agent-prompts-10', title: 'Agent Prompts' },
    content: [paragraph('Mine')],
  });
  const moved = doc(paragraph('Intro'), { type: 'blockquote', content: [lookalike.content[0]] });
  assert.throws(
    () => synchronizeDescription(moved, [], saved.managed, 'agent-prompts-10'),
    /changed, moved or duplicated|untracked/,
  );
  // A changed block is not "deleted": empty selection still refuses.
  const changed = structuredClone(saved.description);
  changed.content[1].content[1].content[0].text = 'Edited';
  assert.throws(
    () => synchronizeDescription(changed, [], saved.managed, 'agent-prompts-10'),
    /changed, moved or duplicated in Jira\. Undo that change, or delete the section/,
  );
  // The way out the message names: delete the section, save no prompts, then add them again.
  const deleted = structuredClone(changed);
  deleted.content.splice(1, 1);
  const forgotten = synchronizeDescription(deleted, [], saved.managed, 'agent-prompts-10');
  assert.equal(forgotten.forgotten, true);
  const again = synchronizeDescription(deleted, [p], forgotten.managed, 'agent-prompts-10');
  assert.deepEqual(again.description, saved.description);
});

test('an untracked Agent Prompts section is found, kept, refused beside a new one, or replaced when named', () => {
  const heading = (text) => ({
    type: 'heading',
    attrs: { level: 2 },
    content: [{ type: 'text', text }],
  });
  // Saved for another work item (a clone), and one pasted without its identifier.
  const cloned = {
    type: 'expand',
    attrs: { localId: 'agent-prompts-77', title: 'Agent Prompts' },
    content: [heading('TEST-7: Old prompt'), paragraph('Old text'), heading('TEST-8: Other')],
  };
  const pasted = { ...cloned, attrs: { title: 'Agent Prompts ' } };
  const users = { type: 'expand', attrs: { title: 'Agent Prompts' }, content: [paragraph('Mine')] };
  const d = doc(paragraph('Intro'), cloned, paragraph('Outro'));
  assert.deepEqual(otherSections(d, null), [
    { index: 1, fingerprint: hash(cloned), keys: ['TEST-7', 'TEST-8'] },
  ]);
  assert.deepEqual(otherSections(doc(pasted), null)[0].keys, ['TEST-7', 'TEST-8']);
  // A user's own expand with that title and no prompt heading is theirs.
  assert.deepEqual(otherSections(doc(users), null), []);
  assert.deepEqual(otherSections(doc({ type: 'panel', content: [cloned] }), null)[0].index, null);
  // A new section is never written beside it.
  assert.throws(
    () => synchronizeDescription(d, [p], null, 'agent-prompts-10'),
    /section the app didn't save\. Delete it from the description, or use its prompts here/,
  );
  // Named by its hash, it is replaced in place.
  const replaced = synchronizeDescription(d, [p], null, 'agent-prompts-10', hash(cloned));
  const own = synchronizeDescription(doc(), [p], null, 'agent-prompts-10').description.content[0];
  assert.deepEqual(replaced.description, doc(paragraph('Intro'), own, paragraph('Outro')));
  assert.deepEqual(otherSections(replaced.description, replaced.managed), []);
  // With the app's own section too, the other one goes and the app's stays where it is.
  const both = doc(cloned, paragraph('Intro'), own);
  const tracked = synchronizeDescription(doc(paragraph('Intro')), [p], null, 'agent-prompts-10');
  assert.deepEqual(
    synchronizeDescription(both, [p], tracked.managed, 'agent-prompts-10', hash(cloned))
      .description,
    doc(paragraph('Intro'), own),
  );
  // Removal leaves the other section as it is.
  assert.deepEqual(
    synchronizeDescription(both, [], tracked.managed, 'agent-prompts-10').description,
    doc(cloned, paragraph('Intro')),
  );
  // A changed, nested or second section, or nothing to replace it with, is refused.
  const changed = hash({ ...cloned, content: [heading('TEST-7: Edited')] });
  for (const [description, prompts, replace] of [
    [d, [p], changed],
    [doc({ type: 'panel', content: [cloned] }), [p], hash(cloned)],
    [doc(cloned, pasted), [p], hash(cloned)],
  ])
    assert.throws(
      () => synchronizeDescription(description, prompts, null, 'agent-prompts-10', replace),
      /other Agent Prompts section changed/,
    );
  assert.throws(
    () => synchronizeDescription(d, [], null, 'agent-prompts-10', hash(cloned)),
    /Choose at least one prompt/,
  );
  // This work item's own identifier on an untracked section is replaced the same way.
  const leftover = { ...cloned, attrs: { localId: 'agent-prompts-10', title: 'Agent Prompts' } };
  assert.deepEqual(
    synchronizeDescription(doc(leftover), [p], null, 'agent-prompts-10', hash(leftover))
      .description,
    doc(own),
  );
});
