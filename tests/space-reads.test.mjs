import './support/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readSpaces } from '../src/space-reads.ts';
test('space reads overlap at most three requests, isolate failures and preserve selection order', async () => {
  const waiting = new Map();
  let active = 0,
    peak = 0;
  const snapshots = [];
  const run = readSpaces(
    ['1', '2', '3', '4', '5'],
    async (id) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => waiting.set(id, resolve));
      active--;
      if (id === '2') throw Error('Denied');
      return id;
    },
    (rows) => snapshots.push(rows),
  );
  assert.deepEqual([...waiting.keys()], ['1', '2', '3']);
  waiting.get('3')();
  await new Promise(setImmediate);
  assert.ok(waiting.has('4'));
  waiting.get('2')();
  await new Promise(setImmediate);
  assert.ok(waiting.has('5'));
  for (const id of ['5', '4', '1']) waiting.get(id)();
  const result = await run;
  assert.equal(peak, 3);
  assert.equal(active, 0);
  assert.deepEqual(
    result.map((r) => r.id),
    ['1', '2', '3', '4', '5'],
  );
  assert.equal(result[1].error, 'Denied');
  assert.equal(result[4].value, '5');
  assert.deepEqual(
    snapshots[0].map((r) => r.id),
    ['3'],
  );
  assert.equal(snapshots.length, 5);
});
