// Shared srcplugins file, synchronized across repositories.
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
// exports { app, checks: [{ title, run(context) }] }. Nothing here writes to Jira: the API helper
// handed to checks reads only, and checks open pages and forms without saving them. The target is
// the app's one production installation on the primary site in the forge-test configuration,
// with `issue`: an existing work item in a configured fixture space whose description carries
// that space's marker. Without a target the smoke is skipped, never passed. Usage:
// node config/production-smoke.mjs <result.json>   (EXPECT_BUILD: the deployed build stamp)

export const checksModule = 'tests/hosted/production-smoke.mjs';
const label = 'Production smoke (read-only, owned site)';

/**
 * The app's production installation on the primary site, or why there is none to check. More
 * than one, or one without a work item, is a configuration error, not a skip.
 */
export function productionTarget(installations, app, primaryHost) {
  const matches = installations.filter(
    (i) => i.app === app && i.site === primaryHost && i.environment === 'production',
  );
  if (!matches.length) return { status: 'skipped', reason: 'no production target' };
  if (matches.length > 1)
    return { status: 'failed', reason: 'more than one production target on the primary site' };
  const [target] = matches;
  if (!/^[A-Z][A-Z0-9_]{1,9}-[1-9]\d*$/.test(target.issue ?? ''))
    return { status: 'failed', reason: 'the production target names no work item (issue)' };
  return { status: 'ready', target };
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
 * table. `failed` is true for any failed check or a configuration error.
 */
export function report({ status, reason, results = [] }) {
  const passed = results.filter((r) => r.ok).map((r) => r.name);
  const failed = results.filter((r) => !r.ok).map((r) => r.name);
  let outcome = status;
  if (status === 'ready') outcome = failed.length || !results.length ? 'failed' : 'passed';
  let notes;
  if (outcome === 'skipped') notes = `${label}: skipped: ${reason}.`;
  else if (outcome === 'passed') notes = `${label}: passed: ${passed.join('; ')}.`;
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
  const level = { failed: 'error', skipped: 'warning', passed: 'notice' }[result.outcome];
  console.log(`::${level}::${result.notes}`);
  return result;
}

async function main([file]) {
  if (!file) throw Error('Usage: node config/production-smoke.mjs <result.json>');
  if (!existsSync(checksModule))
    return finish(file, { status: 'skipped', reason: `no ${checksModule} in this plugin` });
  const { app, checks } = await import(pathToFileURL(resolve(checksModule)).href);
  if (typeof app !== 'string' || !Array.isArray(checks) || !checks.length)
    return finish(file, { status: 'failed', reason: `${checksModule} exports no app and checks` });
  const chosen = productionTarget(config().installations, app, siteFor('primary'));
  if (chosen.status !== 'ready') return finish(file, chosen);

  const { chromium } = await import('@playwright/test');
  const { client, tokenRequest } = await import('@srcplugins/atlassian-forge-test-framework/jira');
  const target = {
    ...chosen.target,
    appId:
      chosen.target.appId ??
      readFileSync('manifest.yml', 'utf8').match(/app\/([0-9a-f-]{36})/)?.[1],
  };
  const request = await tokenRequest();
  const api = client(request);
  // Checks get reads only.
  const get = (path) => api(path);
  let browser;
  try {
    const issue = await get(`/issue/${target.issue}?fields=project,issuetype`);
    if (!issue) return finish(file, { status: 'failed', reason: 'the smoke work item is missing' });
    const spaceKey = issue.fields.project.key;
    const names = fixtureNames(config().fixtures, spaceKey);
    const space = names.length ? await get(`/project/${spaceKey}?expand=description`) : null;
    if (!markedFor(space?.description, names))
      return finish(file, {
        status: 'failed',
        reason: 'the smoke work item is not in a marked fixture space',
      });

    const site = activeTarget();
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const context = await browser.newContext({
      storageState: site.auth,
      viewport: { width: 1440, height: 1100 },
    });
    const viewer = await client(context.request)('/myself');
    if (viewer?.accountId !== (await get('/myself'))?.accountId)
      return finish(file, {
        status: 'failed',
        reason: 'the saved admin session is not the API account (expired session?)',
      });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    const evidence = `${site.directory}/production-smoke`;
    mkdirSync(evidence, { recursive: true });
    const results = await runChecks(
      checks,
      {
        page,
        site: site.site,
        target,
        issue: {
          key: issue.key,
          id: issue.id,
          spaceKey,
          typeName: issue.fields.issuetype.name,
        },
        build: process.env.EXPECT_BUILD || undefined,
        get,
      },
      {
        onFailure: (index) =>
          page.screenshot({ path: `${evidence}/check-${index + 1}.png` }).catch(() => {}),
      },
    );
    return finish(file, { status: 'ready', results });
  } finally {
    await browser?.close();
    await request.dispose();
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
