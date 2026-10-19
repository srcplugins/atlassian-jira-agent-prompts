// Deletes the configuration Jira kept for runner spaces deleted before the runners removed it
// themselves (support/space-leftovers.mjs). `count` only reads; `run` deletes; `cleanup
// <id>` finishes an interrupted run. It holds the site lease, so no suite runs meanwhile, and
// refuses while a setup or access run is unfinished, since those still own their spaces.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { activeTarget, siteFor } from '@srcplugins/atlassian-forge-test-framework/core';
import { client, siteLease, tokenRequest } from '@srcplugins/atlassian-forge-test-framework/jira';
import { spaceLeftovers } from './support/space-leftovers.mjs';

const [mode, recoveryId] = process.argv.slice(2);
assert.ok(
  ['count', 'run'].includes(mode) || (mode === 'cleanup' && /^[0-9a-f-]{36}$/.test(recoveryId)),
  'Usage: cleanup-leftovers.mjs count | run | cleanup <id>',
);
assert.equal(activeTarget().host, siteFor('primary'));
const root = activeTarget().directory;
const tally = (entries) => {
  const out = {};
  for (const x of entries)
    out[`${x.kind}: ${x.state ?? 'found'}`] = (out[`${x.kind}: ${x.state ?? 'found'}`] ?? 0) + 1;
  return out;
};

const r = await tokenRequest();
const api = client(r);
const leftovers = spaceLeftovers(api);
if (mode === 'count') {
  try {
    console.log(tally(await leftovers.find({ live: await leftovers.live() })));
    console.log(`Screen schemes on the site: ${(await api('/screenscheme?maxResults=1')).total}`);
  } finally {
    await r.dispose();
  }
  process.exit(0);
}

for (const [runs, held] of [
  ['native-setup-runs', 'setup.lock'],
  ['native-access-runs', 'access.lock'],
]) {
  const directory = `${root}/${runs}`;
  if (!existsSync(directory)) continue;
  assert.ok(!existsSync(`${directory}/${held}`), `Finish the run holding ${runs}/${held} first`);
  for (const name of readdirSync(directory).filter((x) => x.endsWith('.json')))
    assert.ok(
      JSON.parse(readFileSync(`${directory}/${name}`, 'utf8')).clean,
      `Finish ${runs}/${name} first`,
    );
}
const directory = `${root}/leftover-runs`;
mkdirSync(directory, { recursive: true });
const id = mode === 'run' ? randomUUID() : recoveryId;
const path = `${directory}/${id}.json`;
const lock = `${directory}/leftover.lock`;
if (existsSync(lock)) {
  const holder = JSON.parse(readFileSync(lock, 'utf8'));
  assert.equal(holder.id, id, 'Finish the previous leftover cleanup first');
  let alive = true;
  try {
    process.kill(holder.pid, 0);
  } catch (e) {
    if (e.code === 'ESRCH') alive = false;
  }
  assert.equal(alive, false, 'Leftover cleanup still running or cannot be checked');
  unlinkSync(lock);
}
for (const name of readdirSync(directory).filter((x) => x.endsWith('.json'))) {
  const previous = JSON.parse(readFileSync(`${directory}/${name}`, 'utf8'));
  assert.ok(previous.clean || previous.id === id, 'Finish the previous leftover cleanup first');
}
writeFileSync(lock, JSON.stringify({ id, pid: process.pid }), { flag: 'wx', mode: 0o600 });
const j =
  mode === 'cleanup'
    ? JSON.parse(readFileSync(path, 'utf8'))
    : { id, site: activeTarget().site, clean: false };
assert.equal(j.id, id);
assert.equal(j.site, activeTarget().site);
const persist = () => {
  writeFileSync(`${path}.tmp`, JSON.stringify(j, null, 2) + '\n', { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
};
persist();

const lease = siteLease(api, { holder: 'Agent Prompts leftover cleanup' });
const minute = 60_000;
try {
  await lease.acquire();
  if (!j.leftovers) {
    j.leftovers = await leftovers.find({ live: await leftovers.live() });
    persist();
  }
  console.log(`Leftover cleanup ${id}: ${j.leftovers.length} objects of deleted runner spaces.`);
  let renewed = Date.now();
  let done = 0;
  const stay = await leftovers.remove(j.leftovers, persist, async (x) => {
    if (++done % 250 === 0) console.log(`${done} settled.`);
    if (Date.now() - renewed > 5 * minute) {
      await lease.renew();
      renewed = Date.now();
    }
    // Jira refuses requests while it limits them; give it time before the next one.
    if (x.reason?.includes('HTTP 429')) await new Promise((go) => setTimeout(go, minute / 2));
  });
  j.clean = true;
  persist();
  console.log(tally(j.leftovers));
  if (stay.length) console.log(`${stay.length} stay; their reasons are in ${path}.`);
} finally {
  await lease.release();
  await r.dispose();
  if (j.clean) unlinkSync(lock);
}
