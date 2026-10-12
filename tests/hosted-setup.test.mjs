import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyTypeMappings } from './hosted/support/agent-prompts-setup.mjs';
const baseline = ['1:10', '2:20'];
const scope = { type: '30', schemes: ['2'], defaultScheme: '1', attached: true };
test('native setup accepts only dedicated and observed optional default-scheme additions', () => {
  assert.deepEqual(verifyTypeMappings(baseline, ['1:10', '2:20', '2:30'], scope), {
    defaultSchemeAdded: false,
  });
  assert.deepEqual(verifyTypeMappings(baseline, ['1:10', '1:30', '2:20', '2:30'], scope), {
    defaultSchemeAdded: true,
  });
});
test('native setup refuses unrelated mapping edits and adoption by another scheme', () => {
  for (const current of [
    ['1:10', '2:30'],
    ['1:10', '1:40', '2:20', '2:30'],
    ['1:10', '2:20', '2:30', '4:30'],
    ['1:10', '2:20', '2:30', '2:30'],
    ['1:10', '2:20', 'undefined:30'],
  ])
    assert.throws(() => verifyTypeMappings(baseline, current, scope));
  assert.throws(() => verifyTypeMappings(['undefined:undefined'], ['undefined:undefined'], scope));
});
test('native setup ignores schemes created meanwhile unless they hold the synthetic type', () => {
  assert.deepEqual(verifyTypeMappings(baseline, ['1:10', '2:20', '2:30', '4:40'], scope), {
    defaultSchemeAdded: false,
  });
  assert.throws(() =>
    verifyTypeMappings(baseline, ['1:10', '2:20', '2:30', '4:30', '4:40'], scope),
  );
});
test('native setup cleanup tolerates its planned detach but creation requires attachment', () => {
  assert.throws(() => verifyTypeMappings(baseline, baseline, scope));
  assert.deepEqual(verifyTypeMappings(baseline, baseline, { ...scope, attached: false }), {
    defaultSchemeAdded: false,
  });
});

test('multi-project cleanup allows only the complete journaled scheme scope', () => {
  const scope = { type: '30', schemes: ['2', '3'], defaultScheme: '1', attached: true };
  verifyTypeMappings(baseline, [...baseline, '2:30', '3:30'].sort(), scope);
  assert.throws(() => verifyTypeMappings(baseline, [...baseline, '2:30'].sort(), scope));
  assert.throws(() =>
    verifyTypeMappings(baseline, [...baseline, '2:30', '3:30', '4:30'].sort(), scope),
  );
});
