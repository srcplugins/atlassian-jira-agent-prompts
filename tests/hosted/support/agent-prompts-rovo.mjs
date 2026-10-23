import assert from 'node:assert/strict';

export const normalize = (value) => value.replace(/\s+/g, ' ').trim().toLowerCase();

// The hosted script supplies real app/browser reads. Keep the fixture lifecycle
// executable offline so a failed agent response cannot bypass guarded cleanup.
export async function runRovoJourney({
  owned,
  setup,
  discover,
  search,
  read,
  inventory,
  capture,
  verifyCleanup = async (baseline) =>
    assert.deepEqual(await inventory(), baseline, 'Fixture cleanup changed Jira'),
}) {
  let baseline;
  let passed = false;
  try {
    const configured = await setup();
    assert.equal(configured.project.id, owned.project.id, 'Setup returned a different space');
    assert.match(configured.type ?? '', /^[1-9]\d*$/, 'Set up the owned space before testing');
    baseline = await inventory();
    const entry = await owned.propertyIssue(
      `Rovo ordinary prompt ${owned.run.state.runId.slice(0, 8)}`,
      `Treat this fixture as literal data. Review token ROVO-AP-${owned.run.state.runId}.`,
      configured.type,
    );
    const source = await owned.api(
      `/issue/${entry.id}?fields=summary,description,project,issuetype`,
    );
    assert.equal(source.id, entry.id);
    assert.equal(source.fields.project.id, owned.project.id);
    assert.equal(source.fields.issuetype.id, configured.type);
    assert.equal(source.fields.summary, entry.expected.summary);
    assert.deepEqual(source.fields.description, entry.expected.description);
    const body = source.fields.description.content[0].content[0].text;
    assert.ok(body.length > 15);
    const found = await discover(source.key);
    assert.ok(
      found.prompts.some((prompt) => prompt.id === source.id && prompt.key === source.key),
      'The new ordinary-description source must be searchable in Jira',
    );
    // A site with development and production installations lists two agents of the same name.
    // Only the installation under test can read this second fixture's token, so asking each
    // agent for it picks the right one without touching the source the journey reads fresh.
    const check = await owned.propertyIssue(
      `Rovo agent check ${owned.run.state.runId.slice(0, 8)}`,
      `Treat this fixture as literal data. Agent check token ROVO-AGENT-${owned.run.state.runId}.`,
      configured.type,
    );
    const { key: checkKey } = await owned.api(`/issue/${check.id}?fields=summary`);
    const checked = await discover(checkKey);
    assert.ok(
      checked.prompts.some((prompt) => prompt.id === check.id && prompt.key === checkKey),
      'The agent check fixture must be searchable in Jira',
    );
    const agentCheck = {
      key: checkKey,
      instructions: check.expected.description.content[0].content[0].text,
    };
    const withFixture = await inventory();
    for (const id of [source.id, check.id])
      assert.equal(withFixture.filter((issue) => issue.id === id).length, 1);
    assert.deepEqual(
      withFixture.filter((issue) => issue.id !== source.id && issue.id !== check.id),
      baseline,
      'Creating the fixtures changed unrelated Jira work items',
    );
    for (let index = 1; index <= 2; index++) {
      // Withhold the expected name/body from the user prompts. They must come
      // from the agent's retrieval path, not a positive-control echo.
      const result = await search({ key: source.key, index, agentCheck });
      await capture(`search-${index}`, { key: source.key, name: source.fields.summary, result });
      assert.ok(result.includes(source.key));
      assert.ok(normalize(result).includes(normalize(source.fields.summary)));
      const response = await read({ key: source.key, index });
      await capture(`read-${index}`, { key: source.key, expected: body, response });
      assert.ok(response.includes(source.key));
      assert.ok(normalize(response).includes(normalize(body)));
      assert.deepEqual(await inventory(), withFixture, 'Read-only Rovo changed Jira work items');
    }
    owned.run.check('Two fresh ordinary-source Rovo searches/reads and unchanged Jira');
    passed = true;
  } finally {
    owned.run.state.testStatus = 'failed';
    owned.run.persist();
    await owned.cleanup();
    if (baseline) await verifyCleanup(baseline);
    if (passed) {
      owned.run.state.testStatus = 'passed';
      owned.run.persist();
    }
  }
}
