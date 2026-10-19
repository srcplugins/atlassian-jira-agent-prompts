import './support/typescript-loader.mjs';
const { createConfigurationBatch } = await import('../src/configuration-batch.ts');
const { UserError } = await import('../src/service.ts');
const { screenFixture } = await import('./screen-fixture.mjs');
export function batchFixture(ids = ['1', '2', '7']) {
  let run;
  const configs = new Map();
  const types = [{ id: '3', name: 'Task', subtask: false, hierarchyLevel: 0 }];
  const projects = new Map(
    ids.map((id) => [
      id,
      {
        id,
        key: `PR${id}`,
        name: `Project ${id}`,
        style: 'classic',
        projectTypeKey: 'software',
        issueTypes: [types[0]],
      },
    ]),
  );
  const schemes = new Map(
    [...projects.keys()].map((id) => [
      id,
      { id: `9${id}`, name: `Scheme ${id}`, projectIds: [id], isDefault: false },
    ]),
  );
  const writes = [];
  const screens = screenFixture(() => [...projects.keys()], writes);
  const p = {
    allowed: async () => {},
    project: async (id) => structuredClone(projects.get(id)),
    field: async () => 'customfield_1',
    search: async () => ({ prompts: [], incomplete: false }),
  };
  const s = {
    get: async (id) => structuredClone(configs.get(id)),
    cas: async (id, revision, data, screen, runRevision) => {
      if ((configs.get(id)?.revision ?? 0) !== revision) throw new UserError('Conflict');
      if (runRevision !== undefined && (run?.revision ?? 0) !== runRevision)
        throw new UserError('Conflict');
      screens.check(screen);
      configs.set(id, { revision: revision + 1, data: structuredClone(data) });
      screens.commit(screen);
    },
    types: async () => structuredClone(types),
    scheme: async (id) => structuredClone(schemes.get(id)),
    create: async (name) => {
      writes.push('create');
      types.push({ id: '5', name, subtask: false, hierarchyLevel: 0 });
      return '5';
    },
    attach: async (scheme, type) => {
      writes.push(`attach ${scheme}`);
      for (const [id, value] of schemes) {
        if (value.id !== scheme) continue;
        if (projects.get(id).issueTypes.some((t) => t.id === type))
          throw Error('Already associated');
        projects.get(id).issueTypes.push(types.find((t) => t.id === type));
      }
    },
    ...screens.ports,
    configuring: async (id) => ({
      revision: run?.revision ?? 0,
      changing:
        run?.data.status === 'running' && run.data.entries[run.data.index]?.projectId === id,
    }),
  };
  const w = {
    admin: async () => {},
    get: async () => structuredClone(run),
    cas: async (revision, data) => {
      if ((run?.revision ?? 0) !== revision) throw new UserError('Batch conflict');
      run = { revision: revision + 1, data: structuredClone(data) };
    },
  };
  const batch = createConfigurationBatch(p, s, w);
  // A run's one-time key is held by the page that started it. Here the first argument names the
  // page: 'admin' started the run and holds its key; any other name is another page without it.
  const keys = new Map();
  const keyOf = (page, id) => (page === 'admin' ? keys.get(id) : undefined);
  const api = {
    ...batch,
    async start(page, input, entries, revision) {
      const { key, ...r } = await batch.start(input, entries, revision);
      if (page === 'admin') keys.set(r.data.id, key);
      return r;
    },
    advance: (page, id, revision) => batch.advance(page, keyOf(page, id), id, revision),
    stop: (page, id, revision, acknowledged) =>
      batch.stop(keyOf(page, id), id, revision, acknowledged),
  };
  /** `screenTypes` maps a space to the work types reviewed for its screens. Like Configure, a
   * configuration names a reload choice; keep unless the test chooses one. */
  async function start(options = { name: 'Prompt' }, ids = ['1', '2'], screenTypes = {}) {
    const input = options.unlink ? options : { reloadAfterSave: 'keep', ...options };
    const entries = [];
    for (const projectId of ids) {
      const types = screenTypes[projectId];
      entries.push({
        projectId,
        fingerprint: (
          await api.preview('admin', projectId, {
            ...input,
            ...(types ? { screenTypes: types } : {}),
          })
        ).fingerprint,
        ...(types ? { screenTypes: types } : {}),
      });
    }
    return api.start('admin', input, entries, run?.revision ?? 0);
  }
  return {
    api,
    batch,
    keys,
    p,
    s,
    w,
    writes,
    configs,
    types,
    projects,
    schemes,
    screens,
    start,
    state: () => run,
  };
}
