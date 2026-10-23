// Journal-driven cleanup of the setup runner (verify-setup.mjs), separate so it runs offline too.
import assert from 'node:assert/strict';
import { verifyTypeMappings } from './agent-prompts-setup.mjs';
import { spaceLeftovers } from './space-leftovers.mjs';

/**
 * The baseline plus mappings that work outside the run added meanwhile and the owner reviewed
 * (tests/hosted/cleanup.json's SETUP_ACCEPTED_MAPPINGS, for one recovery). Each must be new, on a
 * scheme the baseline knew, and not the run's own type, so every other change still stops cleanup.
 */
function acceptedBaseline(j, accepted) {
  const schemes = new Set(j.mappingBaseline.map((value) => value.split(':')[0]));
  for (const mapping of accepted) {
    const [scheme, type] = mapping.split(':');
    if (
      !/^[1-9]\d*:[1-9]\d*$/.test(mapping) ||
      !schemes.has(scheme) ||
      type === j.type?.id ||
      j.mappingBaseline.includes(mapping)
    )
      throw Error(
        `Accepted mapping ${mapping} must be new, on a baseline scheme, not the run's type`,
      );
  }
  return [...j.mappingBaseline, ...accepted].sort();
}

/**
 * Cleanup over a run journal `j`, a Jira client `api` and the journal writer `persist`. `accepted`
 * lists reviewed outside mappings (see acceptedBaseline); the journal itself is never changed.
 */
export function setupCleanup({ j, api, persist, accepted = [] }) {
  // A new run records its baseline after this, so it is read when cleanup compares, not here; a
  // recovery's accepted mappings are checked against its journal at once.
  if (accepted.length) acceptedBaseline(j, accepted);
  const baseline = () => acceptedBaseline(j, accepted);
  const leftovers = spaceLeftovers(api);
  async function pages(endpoint) {
    const out = [];
    for (let start = 0, n = 0; n < 100; n++) {
      const v = await api(
        `${endpoint}${endpoint.includes('?') ? '&' : '?'}startAt=${start}&maxResults=100`,
      );
      assert.ok(Array.isArray(v?.values));
      assert.equal(v.startAt, start);
      out.push(...v.values);
      if (v.isLast === true) return out;
      assert.ok(v.values.length > 0);
      start += v.values.length;
    }
    throw Error('Complete pagination required');
  }
  const mappings = async () =>
    (await pages('/issuetypescheme/mapping'))
      .map((x) => `${x.issueTypeSchemeId}:${x.issueTypeId}`)
      .sort();
  // Mappings of schemes that existed at the baseline. Schemes created meanwhile by unrelated work on
  // the shared site are ignored here; one that acquires the synthetic type still fails cleanup.
  const known = (values) => {
    const schemes = new Set(j.mappingBaseline.map((value) => value.split(':')[0]));
    return values.filter((value) => schemes.has(value.split(':')[0]));
  };
  async function emptyProject(f) {
    const p = await api(`/project/${f.project.id}`);
    assert.equal(p?.key, f.key);
    assert.equal(p.description, f.marker);
    assert.equal(p.style, 'classic');
    assert.equal(p.projectTypeKey, 'software');
    const found = await api('/search/jql', 'POST', {
      jql: `project = ${f.project.id}`,
      maxResults: 1,
      fields: ['summary'],
    });
    assert.equal(found.isLast, true);
    assert.equal(found.issues.length, 0);
    const assignment = await pages(`/issuetypescheme/project?projectId=${f.project.id}`);
    assert.equal(assignment.length, 1);
    const current = assignment[0].issueTypeScheme.id;
    assert.ok(current === f.scheme.id || (f.shareIntent && current === j.fixtures[0].scheme.id));
    const expected = [];
    for (const member of j.fixtures) {
      if (!member.project || member.projectDeleted) continue;
      const assigned = await pages(`/issuetypescheme/project?projectId=${member.project.id}`);
      assert.equal(assigned.length, 1);
      if (assigned[0].issueTypeScheme.id === current) expected.push(member.project.id);
    }
    const schemes = await pages(`/issuetypescheme?id=${current}&expand=projects`);
    assert.equal(schemes.length, 1);
    assert.notEqual(schemes[0].isDefault, true);
    assert.equal(schemes[0].projects.isLast, true);
    assert.deepEqual(schemes[0].projects.values.map((x) => x.id).sort(), expected.sort());
    return p;
  }
  async function fieldTab(screen, field = j.field) {
    for (const tab of await api(`/screens/${screen}/tabs`))
      if ((await api(`/screens/${screen}/tabs/${tab.id}/fields`)).some((x) => x.id === field))
        return String(tab.id);
    return undefined;
  }
  /** Steps mode fixtures, in reverse order of creation: the second space's default screen scheme,
   * the first space's mappings, then the screen schemes, screens and work types the run created.
   * Every delete is journaled first and read back; anything not marked as the run's own stops it. */
  async function stepsCleanup() {
    const s = j.steps;
    const one = (found, x) => {
      const named = found.filter((v) => v.name === x.name);
      assert.ok(named.length <= 1, `${x.name} is ambiguous; inspect without retry`);
      if (named.length) x.id = String(named[0].id);
      else x.gone = true;
      persist();
    };
    // A creation whose response was lost is found by its unique name.
    for (const x of s.types) if (x.intent && !x.id && !x.gone) one(await api('/issuetype'), x);
    for (const [path, list] of [
      ['screens', s.screens],
      ['screenscheme', s.schemes],
    ])
      for (const x of list)
        if (x.intent && !x.id && !x.gone)
          one(await pages(`/${path}?queryString=${encodeURIComponent(x.name)}`), x);
    const rows = (itss) => pages(`/issuetypescreenscheme/mapping?issueTypeScreenSchemeId=${itss}`);
    if (s.defaultIntent && !s.defaultRestored) {
      const now = String(
        (await rows(s.itss[1])).find((m) => m.issueTypeId === 'default').screenSchemeId,
      );
      if (now !== s.defaultFrom) {
        assert.equal(now, s.schemes[0].id, 'The second space’s default screens changed');
        s.restoreIntent = true;
        persist();
        await api(`/issuetypescreenscheme/${s.itss[1]}/mapping/default`, 'PUT', {
          screenSchemeId: s.defaultFrom,
        });
      }
      const restored = (await rows(s.itss[1])).find((m) => m.issueTypeId === 'default');
      assert.equal(String(restored.screenSchemeId), s.defaultFrom);
      s.defaultRestored = true;
      persist();
    }
    const types = s.types.filter((x) => x.id).map((x) => x.id);
    if (s.mappingIntent) {
      const ours = (await rows(s.itss[0]))
        .map((m) => String(m.issueTypeId))
        .filter((type) => types.includes(type));
      if (ours.length) {
        s.unmapIntent = true;
        persist();
        await api(`/issuetypescreenscheme/${s.itss[0]}/mapping/remove`, 'POST', {
          issueTypeIds: ours,
        });
      }
      assert.ok(!(await rows(s.itss[0])).some((m) => types.includes(String(m.issueTypeId))));
    }
    for (const x of s.schemes) {
      if (!x.id || x.gone) continue;
      const found = await pages(`/screenscheme?id=${x.id}&expand=issueTypeScreenSchemes`);
      if (found.length) {
        assert.equal(found[0].name, x.name);
        assert.equal(found[0].description, s.marker);
        assert.ok(!found[0].issueTypeScreenSchemes?.values?.length, `${x.name} is still in use`);
        x.deleteIntent = true;
        persist();
        await api(`/screenscheme/${x.id}`, 'DELETE');
        assert.equal((await pages(`/screenscheme?id=${x.id}`)).length, 0);
      }
      x.gone = true;
      persist();
    }
    for (const x of s.screens) {
      if (!x.id || x.gone) continue;
      const found = await pages(`/screens?id=${x.id}`);
      if (found.length) {
        assert.equal(found[0].name, x.name);
        assert.equal(found[0].description, s.marker);
        x.deleteIntent = true;
        persist();
        await api(`/screens/${x.id}`, 'DELETE');
        assert.equal((await pages(`/screens?id=${x.id}`)).length, 0);
      }
      x.gone = true;
      persist();
    }
    const scheme = j.fixtures[0].scheme.id;
    const attached = await mappings();
    for (const x of s.types) {
      if (!x.id || x.gone) continue;
      const t = await api(`/issuetype/${x.id}`);
      if (t) {
        assert.equal(t.name, x.name);
        assert.equal(t.description, s.marker);
        const found = await api('/search/jql', 'POST', {
          jql: `issuetype = ${t.id}`,
          fields: ['summary'],
          maxResults: 1,
        });
        assert.equal(found.issues.length, 0);
        if (attached.includes(`${scheme}:${x.id}`)) {
          x.detachIntent = true;
          persist();
          await api(`/issuetypescheme/${scheme}/issuetype/${x.id}`, 'DELETE');
        }
        x.deleteIntent = true;
        persist();
        await api(`/issuetype/${x.id}`, 'DELETE');
        assert.equal(await api(`/issuetype/${x.id}`), null);
      }
      x.gone = true;
      persist();
    }
    assert.deepEqual(known(await mappings()), baseline());
  }
  async function cleanup() {
    // `steps` is the mode flag until steps mode journals its planned fixtures in its place.
    const planned = typeof j.steps === 'object' ? j.steps : undefined;
    // Reconcile exact unique intents without repeating creation.
    for (const f of j.fixtures) {
      if (!f.project && f.projectIntent) {
        const p = await api(`/project/${f.key}`);
        assert.equal(p?.description, f.marker);
        f.project = { id: String(p.id), key: p.key };
        persist();
      }
      if (!f.project) continue;
      if (f.projectDeleteIntent && (await api(`/project/${f.project.id}`)) === null) {
        f.projectDeleted = true;
        persist();
      }
      if (!f.scheme) {
        const found = await pages(`/issuetypescheme/project?projectId=${f.project.id}`);
        assert.equal(found.length, 1);
        f.scheme = found[0].issueTypeScheme;
        persist();
      }
      if (!f.projectDeleted) await emptyProject(f);
    }
    // Only the journaled screens of the fixture spaces; the app normally removes the field itself.
    // Steps cleanup deletes the run's own screens, and a lost delete leaves one unreadable.
    for (const screen of j.screens ?? []) {
      if (planned?.screens.some((x) => x.id === screen && (x.gone || x.deleteIntent))) continue;
      const tab = await fieldTab(screen);
      if (!tab) continue;
      j.screenCleanupIntent = true;
      persist();
      await api(`/screens/${screen}/tabs/${tab}/fields/${j.field}`, 'DELETE');
      assert.equal(await fieldTab(screen), undefined);
    }
    // Put back what the run took off the prompt create screen, if the app did not.
    for (const removed of j.requiredRemoved ?? []) {
      if (await fieldTab(removed.screen, removed.field)) continue;
      removed.restoreIntent = true;
      persist();
      await api(`/screens/${removed.screen}/tabs/${removed.tab}/fields`, 'POST', {
        fieldId: removed.field,
      });
      assert.ok(await fieldTab(removed.screen, removed.field));
    }
    if (planned) await stepsCleanup();
    if (!j.type && j.typeIntent) {
      const matches = (await api('/issuetype')).filter(
        (x) => x.name === j.typeName || x.name === j.renamed,
      );
      assert.equal(matches.length, 1, 'Type outcome is ambiguous; inspect without retry');
      j.type = matches[0];
      persist();
    }
    if (j.type && !j.typeDeleted) {
      const t = await api(`/issuetype/${j.type.id}`);
      if (t === null) assert.equal(j.typeDeleteIntent, true);
      else {
        assert.ok([j.typeName, j.renamed].includes(t.name));
        assert.equal(
          t.description,
          'Reusable instructions managed through Agent Prompts for Jira.',
        );
        assert.equal(t.hierarchyLevel, 0);
        assert.equal(t.subtask, false);
        const found = await api('/search/jql', 'POST', {
          jql: `issuetype = ${t.id}`,
          fields: ['summary'],
          maxResults: 1,
        });
        assert.equal(found.isLast, true);
        assert.equal(found.issues.length, 0);
        verifyTypeMappings(baseline(), await mappings(), {
          type: t.id,
          schemes: (j.shared ? j.fixtures.slice(0, 1) : j.fixtures).map((f) => f.scheme.id),
          defaultScheme: j.defaultScheme,
          attached: false,
        });
        j.typeDeleteIntent = true;
        persist();
        await api(`/issuetype/${t.id}`, 'DELETE');
        assert.equal(await api(`/issuetype/${t.id}`), null);
      }
      j.typeDeleted = true;
      persist();
      assert.deepEqual(known(await mappings()), baseline());
    }
    for (const f of j.fixtures) {
      if (!f.project) continue;
      if (!f.projectDeleted) {
        await emptyProject(f);
        f.projectDeleteIntent = true;
        persist();
        await api(`/project/${f.project.id}?enableUndo=false`, 'DELETE');
        assert.equal(await api(`/project/${f.project.id}`), null);
        f.projectDeleted = true;
        persist();
      }
    }
    for (const f of j.fixtures) {
      if (!f.scheme) continue;
      const remaining = await pages(`/issuetypescheme?id=${f.scheme.id}&expand=projects`);
      if (remaining.length) {
        assert.equal(remaining.length, 1);
        assert.equal(remaining[0].id, f.scheme.id);
        assert.notEqual(remaining[0].isDefault, true);
        assert.equal(remaining[0].projects.total, 0);
        assert.equal(remaining[0].name, f.scheme.name);
        f.schemeDeleteIntent = true;
        persist();
        await api(`/issuetypescheme/${f.scheme.id}`, 'DELETE');
        assert.equal((await pages(`/issuetypescheme?id=${f.scheme.id}`)).length, 0);
      }
    }
    // The rest of what Jira created with the spaces stays after them.
    if (!j.leftovers) {
      j.leftovers = await leftovers.find({
        keys: j.fixtures.filter((f) => f.project).map((f) => f.key),
      });
      persist();
    }
    const stay = await leftovers.remove(j.leftovers, persist);
    if (stay.length) console.log(`${stay.length} space leftovers stay; see the journal.`);
    j.clean = true;
    persist();
  }
  return { pages, mappings, known, emptyProject, fieldTab, cleanup };
}
