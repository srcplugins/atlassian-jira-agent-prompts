// Shared srcplugins file, synchronized across repositories.
import assert from 'node:assert/strict';
import { forgeContract } from './forge-contract.mjs';

const trusted = { principal: { accountId: 'trusted' } };

/**
 * Contract every Rovo read action must meet: identity and target validation happen before any
 * Jira request; failures are redacted; a refusal or unreadable body is final, while a transport
 * failure or 5xx is tried again up to twice, since a read changes nothing.
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
  for (const [failure, tries] of [
    [{ status: 403 }, 1],
    [{ status: 404 }, 1],
    [{ status: 429 }, 1],
    [{ status: 500 }, 3],
    [{ invalidJson: true }, 1],
    [new Error('private header secret'), 3],
  ]) {
    const sdk = forgeContract(failure, failure, failure);
    const result = await createAction(sdk)(input, trusted);
    assert.equal(result.ok, false);
    assert.doesNotMatch(JSON.stringify(result), /private/);
    assert.equal(
      sdk.calls.length,
      tries,
      tries === 1 ? 'a refusal must not be retried' : 'a transient failure is read three times',
    );
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

/**
 * Every registered resolver is called by the UI: a resolver no UI source names is dead code that
 * knip can't see, because Forge wires resolvers by string. A UI that builds names from a template
 * (`settings-${action}`) covers every resolver with that prefix.
 * @param {string[]} resolvers Names from the real `registerResolvers(sdk)`.
 * @param {string[]} uiSources Text of every UI source file that invokes resolvers.
 */
export function assertResolversCalled(resolvers, uiSources) {
  const ui = uiSources.join('\n');
  const prefixes = [...ui.matchAll(/`([\w-]+-)\$\{/g)].map((m) => m[1]);
  const uncalled = resolvers.filter(
    (name) =>
      !new RegExp(`['"\`]${name}['"\`]`).test(ui) &&
      !prefixes.some((prefix) => name.startsWith(prefix)),
  );
  assert.deepEqual(uncalled, [], 'resolvers no UI calls: remove them or add the caller');
}
