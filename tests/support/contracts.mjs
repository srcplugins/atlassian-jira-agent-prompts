// Shared srcplugins file, synchronized across repositories.
import assert from 'node:assert/strict';
import { forgeContract } from './forge-contract.mjs';

const trusted = { principal: { accountId: 'trusted' } };

/**
 * Contract every Rovo read action must meet: identity and target validation happen before any
 * Jira request; denied, malformed and transient failures are redacted and never retried.
 * @param {(sdk: ReturnType<typeof forgeContract>) => (payload: unknown, context: unknown) => Promise<{ ok: boolean }>} createAction
 * @param {Record<string, string>} input One valid target, such as `{ projectKey: 'TEST' }`.
 */
export async function assertRovoReadContract(createAction, input) {
  const [key] = Object.keys(input);
  // Identity comes only from the trusted principal, never from the payload.
  for (const context of [null, {}, { accountId: 'trusted' }, { principal: { accountId: ' ' } }]) {
    const sdk = forgeContract();
    const result = await createAction(sdk)(
      { ...input, accountId: 'trusted', context: { accountId: 'trusted' } },
      context,
    );
    assert.equal(result.ok, false, `context ${JSON.stringify(context)} must be rejected`);
    assert.equal(sdk.calls.length, 0);
  }
  for (const value of ['', null, [], 'https://site/TEST', 'TEST;DELETE', 'test', 'AA,BB']) {
    const sdk = forgeContract();
    const result = await createAction(sdk)({ [key]: value }, trusted);
    assert.equal(result.ok, false, `${key} ${JSON.stringify(value)} must be rejected`);
    assert.equal(sdk.calls.length, 0);
  }
  for (const failure of [
    { status: 403 },
    { status: 404 },
    { status: 429 },
    { status: 500 },
    { invalidJson: true },
    new Error('private header secret'),
  ]) {
    const sdk = forgeContract(failure);
    const result = await createAction(sdk)(input, trusted);
    assert.equal(result.ok, false);
    assert.doesNotMatch(JSON.stringify(result), /private/);
    assert.equal(sdk.calls.length, 1, 'failures must not be retried');
  }
}

/**
 * Contract for a UI reader of resolver envelopes: valid values pass through unchanged, malformed
 * envelopes throw, controlled denials keep their text and non-string errors never surface.
 * @param {(response: unknown) => unknown} read
 * @param {unknown} valid A complete valid value.
 * @param {Record<string, unknown>} invalid Fields that make the value invalid when merged in.
 */
export function assertEnvelopeReader(read, valid, invalid) {
  assert.deepEqual(read({ ok: true, value: valid }), valid);
  for (const input of [
    null,
    [],
    {},
    { ok: 'true', value: valid },
    { ok: true, value: null },
    { ok: true, value: { .../** @type {object} */ (valid), ...invalid } },
  ])
    assert.throws(() => read(input));
  assert.throws(() => read({ ok: false, error: 'Controlled denial.' }), /Controlled denial/);
  assert.throws(() => read({ ok: false, error: { message: 'PRIVATE' } }), /Invalid response/);
}
