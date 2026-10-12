import './typescript-loader.mjs';
const { createWizard } = await import('../src/wizard.ts');
const { UserError } = await import('../src/service.ts');
export function wizardFixture() {
  let run;
  const configs = new Map();
  const types = [{ id: '3', name: 'Task', subtask: false, hierarchyLevel: 0 }];
  const projects = new Map(
    ['1', '2', '7'].map((id) => [
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
  const p = {
    allowed: async () => {},
    project: async (id) => structuredClone(projects.get(id)),
    field: async () => 'customfield_1',
    search: async () => ({ prompts: [], incomplete: false }),
  };
  const s = {
    get: async (id) => structuredClone(configs.get(id)),
    cas: async (id, revision, data) => {
      if ((configs.get(id)?.revision ?? 0) !== revision) throw new UserError('Conflict');
      configs.set(id, { revision: revision + 1, data: structuredClone(data) });
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
    impact: async () => ({ keys: [], incomplete: false }),
  };
  const w = {
    admin: async () => {},
    projects: async () => ({ projects: [...projects.values()], incomplete: false }),
    get: async () => structuredClone(run),
    cas: async (revision, data) => {
      if ((run?.revision ?? 0) !== revision) throw new UserError('Wizard conflict');
      run = { revision: revision + 1, data: structuredClone(data) };
    },
  };
  const api = createWizard(p, s, w);
  async function start(input = { name: 'Prompt' }, ids = ['1', '2']) {
    const entries = [];
    for (const projectId of ids)
      entries.push({
        projectId,
        fingerprint: (await api.preview('admin', projectId, input)).fingerprint,
      });
    return api.start('admin', input, entries, run?.revision ?? 0);
  }
  return { api, p, s, w, writes, configs, types, projects, schemes, start, state: () => run };
}
