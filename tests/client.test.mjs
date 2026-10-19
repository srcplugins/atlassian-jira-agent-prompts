import test from 'node:test';
import assert from 'node:assert/strict';
import { bridgeClient } from './support/ui-harness.mjs';

test('the client accepts only a boolean result envelope and keeps a null value', async () => {
  const answer = (result) => bridgeClient(async () => result).call('configuration-status');
  for (const result of [undefined, null, {}, { ok: 'true', value: {} }, { ok: 1, value: {} }])
    await assert.rejects(answer(result), /^Error: Unexpected server response\.$/);
  // No stored run is a legitimate null value.
  assert.equal(await answer({ ok: true, value: null }), null);
  assert.deepEqual(await answer({ ok: true, value: { saved: true } }), { saved: true });
  await assert.rejects(answer({ ok: false, error: 'Refused.' }), /^Error: Refused\.$/);
  await assert.rejects(answer({ ok: true }), /Could not reach the app/);
  // An error that is not text is never shown as one.
  for (const error of [{ message: 'x' }, 42, '', undefined])
    await assert.rejects(answer({ ok: false, error }), /^Error: Unexpected server response\.$/);
});
