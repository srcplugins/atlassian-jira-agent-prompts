// License states on the isolation site's development installation, installed fresh for each state
// with `forge install -e development --license <state>` (no `--license` for `none`). The runtime
// license decides, never one the browser sends: without it, prompt use and configuration are
// refused, while reads, setup removal and recovery stay available. Rovo chat isn't available on
// the isolation site, so the Rovo action's refusal is covered by tests/license.test.mjs only.
//   NATIVE_LICENSING_TESTS=1 JIRA_SITE=<isolation site> PLUGIN_TEST_SITE=<isolation site> \
//     node tests/hosted/verify-licensing.mjs inactive|trial|active|none
//   … node tests/hosted/verify-licensing.mjs cleanup <run-uuid>
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import {
  activeEnvironment,
  activeTarget,
  siteFor,
} from '@srcplugins/atlassian-forge-test-framework/core';
import {
  client,
  installation,
  openRun,
  tokenRequest,
} from '@srcplugins/atlassian-forge-test-framework/jira';
import { expect } from './support/expect.mjs';
import { agentPromptsFixture } from './support/fixture.mjs';
import { agentPromptsField, fieldReadView } from './support/field.mjs';
import { editor } from './support/snapshots.mjs';

const refusal =
  'Agent Prompts for Jira has no active subscription on this site. A site administrator can subscribe in Atlassian Administration.';
const states = { inactive: false, trial: true, active: true, none: true };
const [mode, recover] = process.argv.slice(2);
assert.equal(process.env.NATIVE_LICENSING_TESTS, '1', 'Explicit licensing run required');
assert.ok(
  Object.hasOwn(states, mode) || (mode === 'cleanup' && recover),
  'Usage: verify-licensing.mjs inactive|trial|active|none, or cleanup <run-uuid>',
);
// Every state needs its own installation, so this runs only where development installations may
// be removed: the isolation site, never the primary.
assert.equal(activeEnvironment(), 'development');
assert.equal(activeTarget().host, siteFor('isolation'));
assert.equal(process.env.JIRA_SITE, siteFor('isolation'));

const licensed = states[mode];
const target = installation('agent-prompts');
// Lifecycle runs reinstall the same installation, so they share one journal directory and its
// space lock.
const directory = `${activeTarget().directory}/native-lifecycle-runs`;
const request = await tokenRequest();
let browser;
let owned;
let passed = false;
const evidence = { mode, checks: [] };
const check = (name, value) => evidence.checks.push({ name, ...value });

/** The resolver envelope in a GraphQL reply, wherever Forge nests it. */
function envelope(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.ok === 'boolean' && ('value' in value || 'error' in value)) return value;
  for (const child of Object.values(value)) {
    const found = typeof child === 'string' ? parse(child) : envelope(child);
    if (found) return found;
  }
  return null;
}
function parse(text) {
  try {
    return envelope(JSON.parse(text));
  } catch {
    return null;
  }
}
const ours = (input, action) =>
  input?.payload?.call?.functionKey === action &&
  input.payload.context?.environmentId === target.environmentId &&
  input.extensionId?.includes(target.appId);

/**
 * Runs `exercise` and returns this installation's first `action` call: its request, to send
 * again with another function and payload, and its reply envelope.
 */
async function capture(page, action, exercise) {
  /** @type {{ url: string, headers: Record<string, string>, body: any, result: any } | undefined} */
  let call;
  const reply = page.waitForResponse(
    async (response) => {
      try {
        const body = response.request().postDataJSON();
        if (!ours(body?.variables?.input, action)) return false;
        call = {
          url: response.request().url(),
          headers: response.request().headers(),
          body,
          result: envelope(await response.json()),
        };
        return true;
      } catch {
        return false;
      }
    },
    { timeout: 60_000 },
  );
  await Promise.all([reply, exercise()]);
  assert.ok(call, `No ${action} call`);
  return call;
}

/** Sends a captured call again as `functionKey` with `payload`, from the same page and session. */
async function invoke(page, call, functionKey, payload, context = {}) {
  const body = structuredClone(call.body);
  const input = body.variables.input.payload;
  input.call.functionKey = functionKey;
  input.call.payload = payload;
  Object.assign(input.context, context);
  const headers = Object.fromEntries(
    Object.entries(call.headers).filter(
      ([name]) => !['content-length', 'cookie', 'host'].includes(name.toLowerCase()),
    ),
  );
  const response = await page.request.post(call.url, { headers, data: body });
  return envelope(await response.json());
}

/** The resolver is refused for the license exactly when this state has none. */
function gated(name, result) {
  assert.ok(result, `${name}: no resolver reply`);
  if (licensed) assert.notEqual(result.error, refusal, `${name} was refused while licensed`);
  else assert.deepEqual(result, { ok: false, error: refusal }, `${name} was not refused`);
  check(name, { result: result.ok ? 'ok' : result.error });
}
/** The resolver works with or without a license. */
function kept(name, result) {
  assert.ok(result, `${name}: no resolver reply`);
  assert.notEqual(result.error, refusal, `${name} was refused for the license`);
  check(name, { result: result.ok ? 'ok' : result.error });
}

try {
  owned = await openRun(request, agentPromptsFixture, { directory, recover });
  if (mode === 'cleanup') {
    await owned.cleanup();
    console.log(`Licensing run ${recover}: cleanup ${owned.run.state.status}.`);
    passed = true;
  } else {
    owned.run.state.licensing = { mode, environmentId: target.environmentId };
    owned.run.persist();
    const { project } = owned;
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const context = await browser.newContext({
      storageState: `${activeTarget().authDirectory}/admin.json`,
      viewport: { width: 1440, height: 1100 },
    });
    context.setDefaultTimeout(15_000);
    assert.equal(
      (await client(context.request)('/myself')).accountId,
      (await owned.api('/myself')).accountId,
      'The browser session must be the fixture owner',
    );
    const page = await context.newPage();
    const artifact = (name) => `${directory}/${owned.run.state.runId}-licensing-${mode}-${name}`;

    // Configure (UI Kit, drawn in Jira's page): the inventory reports the license, and the page
    // says when there is none.
    const inventory = await capture(page, 'settings-projects', () =>
      page.goto(
        `${activeTarget().site}/jira/settings/apps/configure/${target.appId}/${target.environmentId}`,
      ),
    );
    assert.equal(inventory.result?.ok, true, 'The space inventory loads without a license');
    assert.equal(inventory.result.value.licensed, licensed);
    check('settings-projects', { licensed: inventory.result.value.licensed });
    await expect(page.getByRole('textbox', { name: 'Find a space', exact: true })).toBeEnabled({
      timeout: 60_000,
    });
    await expect(page.getByText('No active subscription', { exact: true })).toHaveCount(
      licensed ? 0 : 1,
    );
    await expect(
      page.getByRole('button', { name: 'Configure selected', exact: true }),
    ).toBeVisible();
    check('Configure banner', { shown: !licensed });
    await page.screenshot({ path: artifact('configure.png'), fullPage: true });

    // The page's own call, sent again to each configuration resolver. Preview only reads.
    const task = project.issueTypes.find((t) => !t.subtask && t.name === 'Task');
    assert.ok(task, 'The fixture space has a Task work type');
    const projectId = project.id;
    kept('configuration-status', await invoke(page, inventory, 'configuration-status', {}));
    kept('settings-health', await invoke(page, inventory, 'settings-health', { projectId }));
    kept(
      'configuration-options',
      await invoke(page, inventory, 'configuration-options', { projectId }),
    );
    kept(
      'configuration-preview (remove setup)',
      await invoke(page, inventory, 'configuration-preview', { projectId, unlink: true }),
    );
    const preview = { projectId, type: task.id, reloadAfterSave: 'keep' };
    gated(
      'configuration-preview (set up)',
      await invoke(page, inventory, 'configuration-preview', preview),
    );
    // A license the browser adds to its request context changes nothing.
    gated(
      'configuration-preview (set up, forged license in the request context)',
      await invoke(page, inventory, 'configuration-preview', preview, {
        license: { active: true, isActive: true },
        environmentType: 'DEVELOPMENT',
      }),
    );

    // The field on a run-owned work item: opening it loads, and its other calls are sent again
    // from that load. Search only reads; save-status reads the pending save.
    const field = await agentPromptsField(owned.api);
    const item = await owned.issue(`Licensing ${mode} ${owned.run.state.runId.slice(0, 8)}`);
    const { key } = await owned.api(`/issue/${item.id}?fields=summary`);
    await page.goto(`${activeTarget().site}/browse/${key}`);
    const readView = fieldReadView(page, field.id);
    await expect(readView).toBeVisible({ timeout: 60_000 });
    // The fixture space isn't set up, so a licensed field shows its picker or the field's own
    // error with Try again; only an unlicensed one shows the refusal.
    const opened = editor(page)
      .getByRole('combobox', { name: 'Agent Prompts', exact: true })
      .or(editor(page).getByRole('button', { name: 'Try again', exact: true }));
    const refused = editor(page).getByText(refusal, { exact: true });
    // Click again only while Jira still shows the read view; opening only reads.
    const load = await capture(page, 'load', () =>
      expect(async () => {
        if (await readView.isVisible())
          await readView.click({ position: { x: 2, y: 2 }, timeout: 5_000 });
        await expect(licensed ? opened.first() : refused).toBeVisible({ timeout: 10_000 });
      }).toPass({ timeout: 60_000, intervals: [1_000, 3_000] }),
    );
    await expect(refused).toHaveCount(licensed ? 0 : 1);
    gated('load', load.result);
    gated('search', await invoke(page, load, 'search', { query: '' }));
    kept('save-status', await invoke(page, load, 'save-status', {}));
    await page.screenshot({ path: artifact('field.png'), fullPage: true });

    passed = true;
  }
} catch (error) {
  evidence.error = error instanceof Error ? error.message : 'Unknown failure';
  process.exitCode = 1;
} finally {
  try {
    if (owned && mode !== 'cleanup') {
      owned.run.state.testStatus = passed ? 'passed' : 'failed';
      owned.run.state.licensing.checks = evidence.checks;
      owned.run.persist();
      await owned.cleanup();
      writeFileSync(
        `${directory}/${owned.run.state.runId}-licensing-${mode}.json`,
        JSON.stringify({ ...evidence, cleanup: owned.run.state.status }, null, 2),
        { mode: 0o600 },
      );
      console.log(
        `Licensing ${mode} ${owned.run.state.runId}: ${passed ? 'passed' : 'failed'}, ${evidence.checks.length} checks, cleanup ${owned.run.state.status}.${evidence.error ? ` ${evidence.error}` : ''}`,
      );
    }
  } finally {
    await browser?.close();
    await request.dispose();
  }
}
