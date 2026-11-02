// Shared srcplugins file, synchronized across repositories.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  activeTarget,
  config,
  isMarker,
  markers,
  siteFor,
} from '@srcplugins/atlassian-forge-test-framework/core';

// Publish's read-only production smoke: after the production deploy, checks the plugin's production
// installation on the primary owned site through its own tests/hosted/production-smoke.mjs, which
// exports { app, checks: [{ title, run(context) }] } and optionally `state(context)` (below).
// Nothing here writes to the host product: the API helper handed to checks reads only, and checks
// open pages and forms without saving them. The host product is the one the plugin's
// forge-test.mjs names (`product`, jira by default), as for the test framework's CLI, and the
// subject and API reads come from that product's framework entry. The target is the app's one
// production installation on the primary site in the forge-test configuration. For Jira it names
// `issue`: an existing work item in a configured fixture space whose description carries that
// space's marker (context.issue). For Confluence the subject is the app's marked Confluence
// fixture space (context.space). Without a target the smoke is skipped, never passed. A target
// that hasn't accepted a new major version yet is reported as waiting for upgrade approval, from
// Forge's installation list (read-only). Usage:
// node config/production-smoke.mjs <result.json>   (EXPECT_BUILD: the deployed build stamp)

export const checksModule = 'tests/hosted/production-smoke.mjs';
const label = 'Production smoke (read-only, owned site)';
// Host products the test framework has an entry for (`@srcplugins/atlassian-forge-test-framework/<product>`).
const hostProducts = ['jira', 'confluence'];

/** The plugin's host product: forge-test.mjs's `product`, jira when it names none. */
export async function hostProduct(file = 'forge-test.mjs') {
  if (!existsSync(file)) return 'jira';
  const { product = 'jira' } = await import(pathToFileURL(resolve(file)).href);
  if (!hostProducts.includes(product))
    throw Error(`forge-test.mjs product must be one of ${hostProducts.join(', ')}.`);
  return product;
}

/**
 * The app's production installation on the primary site, or why there is none to check. More
 * than one, or one without its product's subject (a Jira work item, a configured Confluence
 * fixture space), is a configuration error, not a skip.
 */
export function productionTarget(
  installations,
  app,
  primaryHost,
  { product = 'jira', fixtures } = {},
) {
  const matches = installations.filter(
    (i) => i.app === app && i.site === primaryHost && i.environment === 'production',
  );
  if (!matches.length) return { status: 'skipped', reason: 'no production target' };
  if (matches.length > 1)
    return { status: 'failed', reason: 'more than one production target on the primary site' };
  const [target] = matches;
  if (product === 'confluence') {
    if (!fixtures?.confluenceSpaces?.[app])
      return { status: 'failed', reason: 'the app has no configured Confluence fixture space' };
  } else if (!/^[A-Z][A-Z0-9_]{1,9}-[1-9]\d*$/.test(target.issue ?? ''))
    return { status: 'failed', reason: 'the production target names no work item (issue)' };
  return { status: 'ready', target };
}

/**
 * Whether the target's installation runs the latest major version, from `forge install list
 * --json`. Forge marks the latest major version "(Latest)" and an older one "(Out-of-date)"; an
 * installation on an older one waits for its site administrator to approve the upgrade, so its
 * checks would only see the old build. Anything else this can't read is a failure, never a pass.
 * Forge names the product ("Jira", "Confluence"); it's compared without case, as the framework's
 * installation check does.
 */
export function upgradeState(installations, site, product = 'jira') {
  const matches = (Array.isArray(installations) ? installations : []).filter(
    (i) =>
      i?.environment === 'production' &&
      i.site === site &&
      typeof i.product === 'string' &&
      i.product.toLowerCase() === product,
  );
  if (matches.length !== 1)
    return {
      status: 'failed',
      reason: "Forge's installation list doesn't show the production target exactly once",
    };
  const major = String(matches[0].majorVersion ?? '').match(
    /^(\d+)(?: \((Latest|Out-of-date)\))?$/,
  );
  if (!major)
    return {
      status: 'failed',
      reason: "Forge's installation list gives no readable major version",
    };
  if (major[2] !== 'Latest')
    return {
      status: 'waiting',
      reason: `major version ${major[1]} installed; the site administrator hasn't approved the new major version`,
    };
  return { status: 'ready' };
}

/**
 * This app's installations, through the plugin's Forge CLI (`install list` reads only). A fresh
 * CLI home first asks for analytics consent, which can't be answered without a terminal, so the
 * setting is saved first, as the deploy job does.
 */
export function forgeInstallations(run = spawnSync) {
  const forge = (...args) => {
    const done = run(process.execPath, ['config/forge.mjs', ...args], {
      encoding: 'utf8',
      maxBuffer: 1 << 24,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (done.status === 0) return done;
    // The CLI prints its reason on either stream (a prompt's text on stdout, its error on stderr).
    const said = `${done.stdout ?? ''}\n${done.stderr ?? ''}`.trim().split('\n').slice(-20);
    throw Error(
      [
        `forge ${args.join(' ')} failed (exit ${done.status ?? done.signal ?? done.error?.message})`,
        ...said,
      ].join('\n'),
    );
  };
  forge('settings', 'set', 'usage-analytics', 'false');
  const listed = forge('install', 'list', '--json');
  // The CLI can print notices before the JSON.
  const lines = listed.stdout.split('\n');
  return JSON.parse(lines.slice(lines.findIndex((line) => line.startsWith('['))).join('\n'));
}

/**
 * The plugin's `state(context)` result: undefined or null when the installation can be checked
 * as usual, or { outcome: 'unlicensed', reason } when it has no subscription. Checks still run and
 * read it from `context.state`, so an unlicensed installation is checked for its refusal.
 */
export function checkedState(value) {
  if (value === undefined || value === null) return null;
  if (value?.outcome === 'unlicensed' && typeof value.reason === 'string' && value.reason)
    return { outcome: 'unlicensed', reason: value.reason };
  throw Error('state() returned something other than null or { outcome: "unlicensed", reason }');
}

/**
 * The configured fixture names whose space has this key. Only a configured fixture space is
 * masked in CI logs and owned by the harness, so a work item anywhere else is refused.
 */
export function fixtureNames(fixtures, spaceKey) {
  return Object.entries({ ...fixtures.apps, ...fixtures.projects })
    .filter(([, key]) => key === spaceKey)
    .map(([name]) => name);
}

/** True when a space description is the browser fixture marker of one of these names. */
export const markedFor = (description, names) =>
  names.some((name) => isMarker(description, markers.browserProject(name)));

/**
 * Runs every check in order, even after one fails, so one run reports each broken surface.
 * Error text goes only to the (masked) log; results carry names, outcome and timing.
 */
export async function runChecks(checks, context, { log = console.error, onFailure } = {}) {
  const results = [];
  for (const [index, check] of checks.entries()) {
    const started = performance.now();
    try {
      await check.run(context);
      results.push({ name: check.title, ok: true, seconds: (performance.now() - started) / 1000 });
    } catch (error) {
      log(`${check.title}: ${error?.message ?? error}`);
      await onFailure?.(index, check);
      results.push({ name: check.title, ok: false, seconds: (performance.now() - started) / 1000 });
    }
  }
  return results;
}

/**
 * The outcome, its release-notes line (public: fixed text and check names only) and a summary
 * table. `failed` is true for any failed check or a configuration error. Skipped, waiting for
 * upgrade approval and unlicensed are warnings, never passed.
 */
export function report({ status, reason, state = null, results = [] }) {
  const passed = results.filter((r) => r.ok).map((r) => r.name);
  const failed = results.filter((r) => !r.ok).map((r) => r.name);
  let outcome = status;
  if (status === 'ready')
    outcome = failed.length || !results.length ? 'failed' : (state?.outcome ?? 'passed');
  let notes;
  if (outcome === 'skipped') notes = `${label}: skipped: ${reason}.`;
  else if (outcome === 'waiting') notes = `${label}: waiting for upgrade approval: ${reason}.`;
  else if (outcome === 'passed') notes = `${label}: passed: ${passed.join('; ')}.`;
  else if (outcome === 'unlicensed')
    notes = `${label}: unlicensed: ${state.reason}. Passed: ${passed.join('; ')}.`;
  else
    notes = `${label}: FAILED: ${reason ?? (failed.join('; ') || 'no checks ran')}.${
      passed.length ? ` Passed: ${passed.join('; ')}.` : ''
    }`;
  const rows = results.map(
    (r) => `| ${r.name} | ${r.ok ? 'passed' : '**failed**'} | ${r.seconds.toFixed(1)} |`,
  );
  const summary = [
    `**${notes}**`,
    ...(rows.length ? ['', '| Check | Result | Seconds |', '|---|---|---|', ...rows] : []),
  ].join('\n');
  return { outcome, failed: outcome === 'failed', notes, summary, results };
}

/** Writes the result file and summary, and prints the annotation GitHub shows on the run. */
function finish(file, outcome, env = process.env) {
  const result = report(outcome);
  writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${result.summary}\n`);
  const level = result.failed ? 'error' : result.outcome === 'passed' ? 'notice' : 'warning';
  console.log(`::${level}::${result.notes}`);
  return result;
}

/**
 * Jira's subject: the target's work item, which must be in a configured fixture space carrying its
 * marker, read as the API account; the saved admin session must be that account.
 */
async function jiraSubject({ framework, target, context, disposals }) {
  const request = await framework.tokenRequest();
  disposals.push(() => request.dispose());
  const api = framework.client(request);
  // Checks get reads only.
  const get = (path) => api(path);
  const issue = await get(`/issue/${target.issue}?fields=project,issuetype`);
  if (!issue) return { reason: 'the smoke work item is missing' };
  const spaceKey = issue.fields.project.key;
  const names = fixtureNames(config().fixtures, spaceKey);
  const space = names.length ? await get(`/project/${spaceKey}?expand=description`) : null;
  if (!markedFor(space?.description, names))
    return { reason: 'the smoke work item is not in a marked fixture space' };
  const viewer = await framework.client(context.request)('/myself');
  if (viewer?.accountId !== (await get('/myself'))?.accountId)
    return { reason: 'the saved admin session is not the API account (expired session?)' };
  return {
    get,
    subject: {
      issue: { key: issue.key, id: issue.id, spaceKey, typeName: issue.fields.issuetype.name },
    },
  };
}

/**
 * Confluence's subject: the app's marked Confluence fixture space, read with the saved admin
 * session, which must be a signed-in Confluence user. The framework's Confluence entry reads as
 * that session; its `client` only reads.
 */
async function confluenceSubject({ framework, app, context }) {
  const call = framework.confluenceCall(context.request);
  // GET only: the method argument is never passed on.
  const read = (route) => call(route);
  const user = await read('/wiki/rest/api/user/current');
  if (user.status !== 200 || user.body?.type !== 'known')
    return {
      reason: 'the saved admin session is not a signed-in Confluence user (expired session?)',
    };
  let space;
  try {
    space = await framework.findSpace(read, app);
  } catch (error) {
    console.error(error?.message ?? error);
    return { reason: "the app's Confluence fixture space is not a marked fixture space" };
  }
  if (!space) return { reason: "the app's Confluence fixture space is missing" };
  const api = framework.client(context.request);
  return { get: (path) => api(path), subject: { space } };
}
const subjects = { jira: jiraSubject, confluence: confluenceSubject };

async function main([file]) {
  if (!file) throw Error('Usage: node config/production-smoke.mjs <result.json>');
  if (!existsSync(checksModule))
    return finish(file, { status: 'skipped', reason: `no ${checksModule} in this plugin` });
  const { app, checks, state } = await import(pathToFileURL(resolve(checksModule)).href);
  if (typeof app !== 'string' || !Array.isArray(checks) || !checks.length)
    return finish(file, { status: 'failed', reason: `${checksModule} exports no app and checks` });
  const product = await hostProduct();
  const chosen = productionTarget(config().installations, app, siteFor('primary'), {
    product,
    fixtures: config().fixtures,
  });
  if (chosen.status !== 'ready') return finish(file, chosen);
  let installations;
  try {
    installations = forgeInstallations();
  } catch (error) {
    console.error(error?.message ?? error);
    return finish(file, {
      status: 'failed',
      reason: "the smoke couldn't read Forge's installation list",
    });
  }
  const upgrade = upgradeState(installations, chosen.target.site, product);
  if (upgrade.status !== 'ready') return finish(file, upgrade);

  const { chromium } = await import('@playwright/test');
  // The host product's own framework entry: /jira or /confluence.
  const framework = await import(`@srcplugins/atlassian-forge-test-framework/${product}`);
  const target = {
    ...chosen.target,
    appId:
      chosen.target.appId ??
      readFileSync('manifest.yml', 'utf8').match(/app\/([0-9a-f-]{36})/)?.[1],
  };
  const disposals = [];
  let browser;
  try {
    const site = activeTarget();
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const context = await browser.newContext({
      storageState: site.auth,
      viewport: { width: 1440, height: 1100 },
    });
    const read = await subjects[product]({ framework, app, target, context, disposals });
    if (read.reason) return finish(file, { status: 'failed', reason: read.reason });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    // Evidence goes where Publish collects it (the site's e2e directory) for every product.
    const evidence = `${site.directory}/production-smoke`;
    mkdirSync(evidence, { recursive: true });
    const checkContext = {
      page,
      site: site.site,
      target,
      ...read.subject,
      build: process.env.EXPECT_BUILD || undefined,
      get: read.get,
      state: null,
    };
    if (typeof state === 'function') {
      try {
        checkContext.state = checkedState(await state(checkContext));
      } catch (error) {
        console.error(`state: ${error?.message ?? error}`);
        await page.screenshot({ path: `${evidence}/state.png` }).catch(() => {});
        return finish(file, {
          status: 'failed',
          reason: "the smoke couldn't read the installation's state",
        });
      }
    }
    const results = await runChecks(checks, checkContext, {
      onFailure: (index) =>
        page.screenshot({ path: `${evidence}/check-${index + 1}.png` }).catch(() => {}),
    });
    return finish(file, { status: 'ready', state: checkContext.state, results });
  } finally {
    await browser?.close();
    for (const dispose of disposals) await dispose();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const file = process.argv[2];
  try {
    const result = await main(process.argv.slice(2));
    if (result.failed) process.exitCode = 1;
  } catch (error) {
    // A crash is a failed smoke, never a silent one; its message stays in the masked log.
    console.error(error?.message ?? error);
    if (file) finish(file, { status: 'failed', reason: 'the smoke did not complete' });
    process.exitCode = 1;
  }
}
