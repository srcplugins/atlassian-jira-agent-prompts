// Jira keeps the configuration it creates with a company-managed space after the space is deleted.
// For a runner's Kanban space K that is a work type screen scheme, three screen schemes
// and three screens named "K: …", the workflow scheme "K: …" with its workflow "… for Project K",
// and the board filter "Filter for K board"; the board itself goes with the space. The runners
// delete these after their spaces, and cleanup-leftovers.mjs sweeps those of earlier runs.
import assert from 'node:assert/strict';

// Space keys of the setup runner (NP, seven hex digits, a fixture index) and the access runner.
const runnerKey = '(NP[0-9A-F]{7}[0-9]|NA[0-9A-F]{7})';
const prefixed = new RegExp(`^${runnerKey}: `);
const settled = ['deleted', 'kept', 'refused'];

/** Finds and deletes the leftovers of deleted runner spaces through the Jira client `api`. */
export function spaceLeftovers(api) {
  async function list(path) {
    const out = [];
    for (let start = 0, n = 0; n < 200; n++) {
      const v = await api(
        `${path}${path.includes('?') ? '&' : '?'}startAt=${start}&maxResults=100`,
      );
      assert.ok(Array.isArray(v?.values));
      out.push(...v.values);
      if (v.isLast === true) return out;
      assert.ok(v.values.length > 0);
      start += v.values.length;
    }
    throw Error('Complete pagination required');
  }
  const first = async (path) => (await list(path))[0] ?? null;
  const named = (path, parameter, text) =>
    text ? `${path}?${parameter}=${encodeURIComponent(text)}` : path;
  let account;
  const unused = (values, reason) => (values?.length === 0 ? undefined : reason);
  // In deletion order: each kind is used only by kinds before it. `find(key)` lists the candidates
  // of one space key, or of every runner key when `key` is empty; `keep` says why one must stay.
  const kinds = [
    {
      kind: 'work type screen scheme',
      owner: prefixed,
      find: (key) => list(named('/issuetypescreenscheme', 'queryString', key)),
      read: (id) => first(`/issuetypescreenscheme?id=${id}`),
      keep: async (x) =>
        unused(await list(`/issuetypescreenscheme/${x.id}/project`), 'used by a space'),
      path: (id) => `/issuetypescreenscheme/${id}`,
    },
    {
      kind: 'screen scheme',
      owner: prefixed,
      find: (key) => list(named('/screenscheme', 'queryString', key)),
      read: (id) => first(`/screenscheme?id=${id}&expand=issueTypeScreenSchemes`),
      keep: async (x) =>
        unused(x.issueTypeScreenSchemes?.values, 'used by a work type screen scheme'),
      path: (id) => `/screenscheme/${id}`,
    },
    {
      kind: 'screen',
      owner: prefixed,
      find: (key) => list(named('/screens', 'queryString', key)),
      read: (id) => first(`/screens?id=${id}`),
      // No endpoint lists a screen's users; Jira refuses to delete one that is still used.
      keep: async () => undefined,
      path: (id) => `/screens/${id}`,
    },
    {
      kind: 'workflow scheme',
      owner: prefixed,
      everyKey: true,
      find: () => list('/workflowscheme'),
      read: (id) => api(`/workflowscheme/${id}`),
      keep: async (x) =>
        unused(
          (await api(`/workflowscheme/${x.id}/projectUsages?maxResults=1`))?.projects?.values,
          'used by a space',
        ),
      path: (id) => `/workflowscheme/${id}`,
    },
    {
      kind: 'workflow',
      owner: new RegExp(` for Project ${runnerKey}$`),
      find: (key) => list(named('/workflows/search', 'queryString', `for Project ${key || 'N'}`)),
      read: async (id, name) =>
        (await list(named('/workflows/search', 'queryString', name))).find((w) => w.id === id) ??
        null,
      keep: async (x) =>
        unused(
          (await api(`/workflow/${x.id}/workflowSchemes?maxResults=1`))?.workflowSchemes?.values,
          'used by a workflow scheme',
        ),
      path: (id) => `/workflow/${id}`,
    },
    {
      kind: 'board filter',
      owner: new RegExp(`^Filter for ${runnerKey} board$`),
      find: (key) => list(named('/filter/search', 'filterName', `Filter for ${key || 'N'}`)),
      read: (id) => api(`/filter/${id}?expand=jql`),
      // Nothing lists a filter's boards, so only this account's filter of its space alone goes,
      // and only once everything else of that space is gone.
      keep: async (x, entry, entries) => {
        account ??= (await api('/myself')).accountId;
        if (
          x.jql !== `project = "${entry.key}" ORDER BY Rank ASC` ||
          x.owner?.accountId !== account
        )
          return 'changed since Jira created it';
        if (entries.some((e) => e.key === entry.key && ['kept', 'refused'].includes(e.state)))
          return 'another object of its space stays';
      },
      path: (id) => `/filter/${id}`,
    },
  ];

  /** The keys of the spaces that exist now. */
  async function live() {
    return new Set((await list('/project/search')).map((p) => p.key));
  }

  /**
   * Leftovers of the deleted spaces `keys`, or of every runner space key not in `live`.
   * @param {{ keys?: string[], live?: Set<string> }} options
   */
  async function find({ keys, live = new Set() }) {
    if (keys && !keys.length) return [];
    const found = new Map();
    for (const k of kinds)
      for (const key of k.everyKey || !keys ? [''] : keys)
        for (const x of await k.find(key)) {
          const owner = x.name?.match(k.owner)?.[1];
          if (!owner || live.has(owner) || (keys && !keys.includes(owner))) continue;
          const id = String(x.id);
          found.set(`${k.kind} ${id}`, { kind: k.kind, id, name: x.name, key: owner });
        }
    return [...found.values()];
  }

  /**
   * Deletes `entries` from `find`, kept in a journal, kind by kind. Each delete is journaled as
   * intent first and read back. One already gone counts as deleted; one still in use or refused by
   * Jira stays with its reason; any other failure stops, and the next run reads that one back
   * before acting. `after(entry)` runs once each entry is settled. Returns the entries that stay.
   */
  /** @param {(entry: any) => Promise<void>} [after] */
  async function remove(entries, persist, after = async () => {}) {
    const absent = new Set();
    const settle = async (x, state, reason) => {
      Object.assign(x, { state }, reason && { reason });
      persist();
      await after(x);
    };
    for (const k of kinds)
      for (const x of entries.filter((e) => e.kind === k.kind && !settled.includes(e.state))) {
        const now = await k.read(x.id, x.name);
        if (!now) {
          await settle(x, 'deleted');
          continue;
        }
        assert.equal(now.name, x.name, `The ${k.kind} ${x.id} was renamed; inspect it first`);
        if (!absent.has(x.key)) {
          assert.equal(await api(`/project/${x.key}`), null, `Space ${x.key} exists`);
          absent.add(x.key);
        }
        const reason = await k.keep(now, x, entries);
        if (reason) {
          await settle(x, 'kept', reason);
          continue;
        }
        x.state = 'intent';
        persist();
        try {
          await api(k.path(x.id), 'DELETE');
        } catch (error) {
          // A definitive rejection changed nothing; any other failure stays journaled as intent.
          if (!error.definitiveRejection) throw error;
          await settle(x, 'refused', error.message);
          continue;
        }
        assert.equal(await k.read(x.id, x.name), null, `The ${k.kind} ${x.id} is still there`);
        await settle(x, 'deleted');
      }
    return entries.filter((x) => x.state !== 'deleted');
  }

  return { live, find, remove };
}
