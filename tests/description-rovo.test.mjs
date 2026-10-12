import './typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { forgeContract } from './support/forge-contract.mjs';
const { registerDescriptionRovo } = await import('../src/integration.ts');
const context = { principal: { accountId: 'actor' } };
const description = {
  type: 'doc',
  version: 1,
  content: [
    { type: 'syncBlock', attrs: { localId: 'target', resourceId: 'jira-work-item/7/source' } },
  ],
};
test('description diagnostic returns raw reference and HTML with exactly one asUser GET; never resolves source', async () => {
  const sdk = forgeContract({
    body: {
      key: 'TEST-1',
      fields: { description, summary: 'Excluded' },
      renderedFields: { description: '<p>Unavailable</p>' },
    },
  });
  const result = await registerDescriptionRovo(sdk)(
    { issueKey: 'TEST-1', accountId: 'spoofed' },
    context,
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.descriptionAdf, description);
  assert.equal(result.value.renderedDescriptionHtml, '<p>Unavailable</p>');
  assert.equal('summary' in result.value, false);
  assert.equal(sdk.calls.length, 1);
  assert.equal(sdk.calls[0].actor, 'asUser');
  assert.equal(sdk.calls[0].method, 'GET');
  assert.equal(
    sdk.calls[0].path,
    '/rest/api/3/issue/TEST-1?fields=description&expand=renderedFields',
  );
});
test('description diagnostic rejects missing identity and invalid keys before reading', async () => {
  for (const [payload, raw] of [
    [{ issueKey: 'TEST-1' }, {}],
    [{ issueKey: '../TEST-1' }, context],
    [{}, context],
  ]) {
    const sdk = forgeContract();
    assert.equal((await registerDescriptionRovo(sdk)(payload, raw)).ok, false);
    assert.equal(sdk.calls.length, 0);
  }
});
test('description diagnostic preserves null and rejects denied, malformed, oversized or failed reads without retry', async () => {
  const empty = forgeContract({ body: { key: 'TEST-1', fields: { description: null } } });
  const result = await registerDescriptionRovo(empty)({ issueKey: 'TEST-1' }, context);
  assert.equal(result.ok, true);
  assert.equal(result.value.descriptionAdf, null);
  for (const response of [
    { status: 403 },
    { body: { key: 'OTHER-1', fields: { description: null } } },
    {
      body: {
        key: 'TEST-1',
        fields: { description: null },
        renderedFields: { description: 'x'.repeat(60001) },
      },
    },
    new Error('private secret'),
  ]) {
    const sdk = forgeContract(response);
    const r = await registerDescriptionRovo(sdk)({ issueKey: 'TEST-1' }, context);
    assert.equal(r.ok, false);
    assert.equal(sdk.calls.length, 1);
    assert.ok(!JSON.stringify(r).includes('private secret'));
  }
});
