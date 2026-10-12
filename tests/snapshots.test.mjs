import './typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { snapshotContent, synchronizeDescription } = await import('../src/description.ts');
const { hash } = await import('../src/service.ts');
const paragraph = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const doc = (...content) => ({ type: 'doc', version: 1, content });
const p = { id: '20', name: 'TEST-20: Review', content: [paragraph('Check errors')] };
test('ordinary source instructions and real legacy source bodies work; unresolved references fail', () => {
  assert.deepEqual(snapshotContent(doc(...p.content)), p.content);
  assert.deepEqual(
    snapshotContent(doc({ type: 'bodiedSyncBlock', content: p.content })),
    p.content,
  );
  for (const d of [null, doc(), doc({ type: 'syncBlock' }), doc({ type: 'mediaSingle' })])
    assert.throws(() => snapshotContent(d));
});
test('save, ordered refresh and unlink preserve unrelated rich ADF and input objects', () => {
  const original = doc(
    { type: 'table', attrs: { layout: 'wide' }, content: [] },
    { type: 'expand', attrs: { title: 'Agent Prompts' }, content: [paragraph('User-owned')] },
    { type: 'extension', attrs: { custom: 'untouched' } },
  );
  const baseline = structuredClone(original);
  const linked = synchronizeDescription(original, [p], null, 'npl-10');
  assert.deepEqual(original, baseline);
  assert.deepEqual(linked.description.content.slice(0, 3), original.content);
  const second = { id: '21', name: 'Second', content: [paragraph('Different instructions')] };
  const refreshed = synchronizeDescription(
    linked.description,
    [second, p],
    linked.managed,
    'npl-10',
  );
  assert.equal(refreshed.description.content[3].content[0].content[0].text, 'Second');
  assert.equal(refreshed.description.content[3].content[2].content[0].text, p.name);
  assert.deepEqual(
    synchronizeDescription(refreshed.description, [], refreshed.managed, 'npl-10').description,
    original,
  );
});
test('changed, missing, duplicate, nested and untracked expanders stop writes', () => {
  const linked = synchronizeDescription(doc(), [p], null, 'npl-10');
  for (const mode of ['changed', 'missing', 'duplicate', 'nested', 'untracked']) {
    const d = structuredClone(linked.description);
    const n = d.content[0];
    if (mode === 'changed') n.content[1] = paragraph('Manual override');
    if (mode === 'missing') d.content = [];
    if (mode === 'duplicate') d.content.push(structuredClone(n));
    if (mode === 'nested') d.content = [{ type: 'expand', content: [n] }];
    assert.throws(() =>
      synchronizeDescription(d, [p], mode === 'untracked' ? null : linked.managed, 'npl-10'),
    );
  }
});
test('explicit save migrates only fingerprinted native references, preserving intervening content', () => {
  const reference = {
    type: 'syncBlock',
    attrs: { localId: 'old-20', resourceId: 'jira-work-item/20/abc' },
  };
  const second = {
    type: 'syncBlock',
    attrs: { localId: 'old-21', resourceId: 'jira-work-item/21/abc' },
  };
  const original = doc(
    paragraph('Before'),
    reference,
    paragraph('Between'),
    second,
    paragraph('After'),
  );
  const managed = {
    mode: 'synced',
    references: [reference, second].map((node, i) => ({
      promptId: String(20 + i),
      ...node.attrs,
      fingerprint: hash(node),
    })),
  };
  const next = synchronizeDescription(original, [p], managed, 'npl-10');
  assert.deepEqual(
    next.description.content.filter((n) => n.type !== 'expand'),
    [original.content[0], original.content[2], original.content[4]],
  );
  assert.equal(next.description.content[1].type, 'expand');
  reference.attrs.resourceId = 'Changed';
  assert.throws(() => synchronizeDescription(original, [p], managed, 'npl-10'));
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
    /block was removed in Jira/,
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
    /changed, moved or removed|untracked/,
  );
  // A changed block is not "deleted": empty selection still refuses.
  const changed = structuredClone(saved.description);
  changed.content[1].content[1].content[0].text = 'Edited';
  assert.throws(
    () => synchronizeDescription(changed, [], saved.managed, 'npl-10'),
    /changed, moved or removed/,
  );
});

test('empty-attribute reconstruction is bounded at eight candidate nodes and 32 KB', async () => {
  const { recoverEmptyAttributes, blockShape } = await import('../src/description.ts');
  const { createHash } = await import('node:crypto');
  const canonical = (v) =>
    Array.isArray(v)
      ? `[${v.map(canonical).join(',')}]`
      : v && typeof v === 'object'
        ? `{${Object.keys(v)
            .sort()
            .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
            .join(',')}}`
        : JSON.stringify(v);
  const fingerprint = (node) => createHash('sha256').update(canonical(node)).digest('hex');
  // Each attr-less paragraph and its text node are two candidates: 4 paragraphs = 8 (the bound).
  for (const [paragraphs, recovers] of [
    [4, true],
    [5, false],
  ]) {
    // Fingerprinted with empty attrs on every paragraph; Jira then dropped them all.
    const original = {
      type: 'expand',
      attrs: { localId: 'npl-10', title: 'Agent Prompts' },
      content: Array.from({ length: paragraphs }, (_, i) => ({
        ...paragraph(`Step ${i}`),
        attrs: {},
      })),
    };
    const stored = structuredClone(original);
    stored.content.forEach((node) => delete node.attrs);
    const managed = { localId: 'npl-10', fingerprint: fingerprint(original) };
    assert.equal(
      recoverEmptyAttributes(doc(stored), managed) !== undefined,
      recovers,
      String(paragraphs),
    );
  }
  // Oversized blocks are never reconstructed.
  const big = {
    type: 'expand',
    attrs: { localId: 'npl-10', title: 'Agent Prompts' },
    content: [{ ...paragraph('x'.repeat(33_000)), attrs: {} }],
  };
  const bigStored = structuredClone(big);
  delete bigStored.content[0].attrs;
  assert.equal(
    recoverEmptyAttributes(doc(bigStored), { localId: 'npl-10', fingerprint: fingerprint(big) }),
    undefined,
  );
  assert.equal(typeof blockShape(big), 'string');
});
