import './support/typescript-loader.mjs';
const { UserError } = await import('../src/service.ts');
/**
 * An in-memory Jira screen model for the settings ports. Every space starts with its own screen
 * (`100<space>`) for every work type and operation, holding Summary and Description on one tab.
 * `use` assigns another screen to a space's work type and operation; `screen` creates or reads one.
 * Jira writes are appended to `writes` as `add <screen> <field>` and `remove <screen> <field>`.
 */
export function screenFixture(spaces, writes = []) {
  const screens = new Map();
  const records = new Map();
  const assigned = new Map();
  const incomplete = new Set();
  const late = new Set();
  function screen(id, fields = ['summary', 'description']) {
    if (!screens.has(id))
      screens.set(id, { id, name: `Screen ${id}`, tabs: [{ id: `${id}1`, fields: [...fields] }] });
    return screens.get(id);
  }
  const screenFor = (space, type, op) =>
    assigned.get(`${space}:${type ?? ''}:${op}`) ??
    assigned.get(`${space}::${op}`) ??
    screen(`100${space}`).id;
  function use(space, type, op, id, fields) {
    screen(id, fields);
    for (const o of op === '*' ? ['create', 'edit', 'view'] : [op])
      assigned.set(`${space}:${type ?? ''}:${o}`, id);
  }
  function tab(id, tabId) {
    const found = screens.get(id)?.tabs.find((t) => t.id === tabId);
    if (!found) throw new UserError('Jira request failed (HTTP 404).');
    return found;
  }
  const ports = {
    screenUses: async (space, uses) => uses.map((u) => screen(screenFor(space, u.type, u.op)).id),
    screens: async (ids) => ids.map((id) => structuredClone(screens.get(id))),
    screenImpact: async (id) => ({
      projects: spaces()
        .filter(
          (space) =>
            [...assigned].some(([key, value]) => value === id && key.startsWith(`${space}:`)) ||
            id === `100${space}`,
        )
        .map((space) => ({ id: space, key: `PR${space}`, name: `Project ${space}` })),
      complete: !incomplete.has(id) && !late.has(id),
      ...(late.has(id) ? { timedOut: true } : {}),
    }),
    addScreenField: async (id, tabId, field) => {
      writes.push(`add ${id} ${field}`);
      const t = tab(id, tabId);
      if (screens.get(id).tabs.some((x) => x.fields.includes(field)))
        throw new UserError('Jira request failed (HTTP 400).');
      t.fields.push(field);
    },
    removeScreenField: async (id, tabId, field) => {
      writes.push(`remove ${id} ${field}`);
      const t = tab(id, tabId);
      if (!t.fields.includes(field)) throw new UserError('Jira request failed (HTTP 400).');
      t.fields.splice(t.fields.indexOf(field), 1);
    },
    screenRecord: async (id) => structuredClone(records.get(id)),
    // An earlier run, finished; the batch fixture answers from its stored run.
    configuring: async () => ({ revision: 1, changing: false }),
    timeLeft: () => clock.left,
  };
  const clock = { left: 22_000 };
  return {
    ports,
    clock,
    screens,
    records,
    incomplete,
    late,
    screen,
    use,
    /** Rejects a stale ownership record write, as the storage transaction's condition does. */
    check(change) {
      if (change && (records.get(change.id)?.revision ?? 0) !== change.revision)
        throw new UserError('Setup changed');
    },
    commit(change) {
      if (!change) return;
      if (change.data === null) records.delete(change.id);
      else
        records.set(change.id, {
          revision: change.revision + 1,
          data: structuredClone(change.data),
        });
    },
  };
}
