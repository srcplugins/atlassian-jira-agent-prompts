// In-memory Jira for the setup runner's cleanup and the space leftovers: only the REST endpoints
// they use, paged two at a time. Anything else throws, so a new request in cleanup fails its test
// until it is modelled.
//
// World: { projects, typeSchemes, types, screens, screenSchemes, itss, workflowSchemes, workflows,
// filters }, each keyed by id. projects: { key, description, scheme, itss, workflowScheme? };
// typeSchemes: { name, isDefault?, types: [id] }; types: { name, description, hierarchyLevel,
// subtask }; screens: { name, description, tabs: [{ id, fields: [fieldId] }] }; screenSchemes:
// { name, description, screens }; itss: { name, rows: { [workTypeId | 'default']: screenSchemeId } };
// workflowSchemes: { name, defaultWorkflow }; workflows: { name }; filters: { name, jql, owner }.
// `lose` names one write ('METHOD path') that Jira applies but whose response is lost; `drop` one
// that fails without reaching Jira; `refuse` one that Jira rejects with an error status.
const account = 'runner-account';

/** What Jira creates with a Kanban space `key`, numbered from `base`; returns the space's ids. */
export function kanbanSpace(world, key, base) {
  const id = (n) => String(base + n);
  for (const kind of ['workflowSchemes', 'workflows', 'filters']) world[kind] ??= {};
  const kinds = [
    ['Default', 'Default Issue'],
    ['Bug', 'Bug'],
    ['Epic', 'Epic'],
  ];
  world.itss[id(0)] = {
    name: `${key}: Kanban Issue Type Screen Scheme`,
    rows: { default: id(10), 10004: id(11), 10000: id(12) },
  };
  kinds.forEach(([scheme, screen], n) => {
    world.screenSchemes[id(10 + n)] = {
      name: `${key}: Kanban ${scheme} Screen Scheme`,
      description: '',
      screens: { default: base + 20 + n },
    };
    world.screens[id(20 + n)] = {
      name: `${key}: Kanban ${screen} Screen`,
      description: '',
      tabs: [],
    };
  });
  const workflow = `Software Simplified Workflow for Project ${key}`;
  world.workflowSchemes[id(0)] = {
    name: `${key}: Software Simplified Workflow Scheme`,
    defaultWorkflow: workflow,
  };
  world.workflows[`workflow-${id(0)}`] = { name: workflow };
  world.filters[id(0)] = {
    name: `Filter for ${key} board`,
    jql: `project = "${key}" ORDER BY Rank ASC`,
    owner: account,
  };
  return { itss: id(0), workflowScheme: id(0) };
}

/**
 * @param {any} world
 * @param {{ lose?: string, drop?: string, refuse?: string }} [faults]
 */
export function fakeJira(world, { lose, drop, refuse } = {}) {
  const calls = [];
  const writes = [];
  world.workflowSchemes ??= {};
  world.workflows ??= {};
  world.filters ??= {};
  const { projects, typeSchemes, types, screens, screenSchemes, itss } = world;
  const { workflowSchemes, workflows, filters } = world;
  // Jira answers a write on something still in use with an error status, changing nothing.
  const inUse = (what) =>
    Object.assign(Error(`Fixture API DELETE failed (HTTP 400): ${what} in use`), {
      definitiveRejection: true,
    });
  const page = (values, q) => {
    const startAt = Number(q.get('startAt') ?? 0);
    const slice = values.slice(startAt, startAt + Math.min(Number(q.get('maxResults')), 2));
    return { startAt, isLast: startAt + slice.length >= values.length, values: slice };
  };
  const exists = (map, id) => {
    if (!Object.hasOwn(map, id)) throw Error(`Fake Jira 404: ${id}`);
    return map[id];
  };
  const project = (id) => {
    const p = projects[id];
    return {
      id,
      key: p.key,
      description: p.description,
      style: 'classic',
      projectTypeKey: 'software',
    };
  };
  const typeScheme = (id, expand) => ({
    id,
    name: typeSchemes[id].name,
    ...(typeSchemes[id].isDefault ? { isDefault: true } : {}),
    ...(expand === 'projects' && {
      projects: (({ values }) => ({ isLast: true, total: values.length, values }))({
        values: Object.keys(projects)
          .filter((p) => projects[p].scheme === id)
          .map((p) => ({ id: p })),
      }),
    }),
  });
  const usingScheme = (scheme) =>
    Object.keys(itss).filter((i) => Object.values(itss[i].rows).includes(scheme));
  const workflowScheme = (id) => ({
    id: Number(id),
    name: workflowSchemes[id].name,
    defaultWorkflow: workflowSchemes[id].defaultWorkflow,
    issueTypeMappings: {},
  });
  const usingWorkflow = (id) =>
    Object.keys(workflowSchemes).filter(
      (s) => workflowSchemes[s].defaultWorkflow === workflows[id].name,
    );
  const screenScheme = (id, expand) => ({
    id: Number(id),
    name: screenSchemes[id].name,
    description: screenSchemes[id].description,
    screens: screenSchemes[id].screens,
    ...(expand === 'issueTypeScreenSchemes' && {
      issueTypeScreenSchemes: { isLast: true, values: usingScheme(id).map((i) => ({ id: i })) },
    }),
  });
  const named = (map, q, json) =>
    Object.keys(map)
      .filter((id) => !q.has('id') || id === q.get('id'))
      .filter((id) => !q.has('queryString') || map[id].name.includes(q.get('queryString')))
      .map((id) => json(id, q.get('expand')));
  const tab = (screen, id) => {
    const found = exists(screens, screen).tabs.find((t) => String(t.id) === id);
    if (!found) throw Error(`Fake Jira 404: tab ${id}`);
    return found;
  };
  const paged = ['startAt', 'maxResults'];
  // [method, path pattern, query parameters allowed, handler(match, query, body)]
  /** @type {Array<[string, RegExp, string[], (match: any, q: URLSearchParams, body?: any) => any]>} */
  const routes = [
    [
      'GET',
      /^\/project\/search$/,
      paged,
      (_, q) =>
        page(
          Object.keys(projects).map((id) => ({ id, key: projects[id].key })),
          q,
        ),
    ],
    [
      'GET',
      /^\/project\/(\w+)$/,
      [],
      ([, id]) => {
        const found = Object.keys(projects).find((p) => p === id || projects[p].key === id);
        return found ? project(found) : null;
      },
    ],
    [
      'DELETE',
      /^\/project\/(\d+)$/,
      ['enableUndo'],
      ([, id], q) => {
        if (q.get('enableUndo') !== 'false') throw Error('Project delete must skip the trash');
        exists(projects, id);
        delete projects[id];
      },
    ],
    [
      'POST',
      /^\/search\/jql$/,
      [],
      (_, q, body) => {
        if (!/^(project|issuetype) = \d+$/.test(body.jql))
          throw Error(`Unexpected JQL ${body.jql}`);
        return { isLast: true, issues: [] };
      },
    ],
    [
      'GET',
      /^\/issuetypescheme\/project$/,
      ['projectId', ...paged],
      (_, q) => {
        const p = projects[q.get('projectId')];
        const values = p
          ? [{ issueTypeScheme: typeScheme(p.scheme), projectIds: [q.get('projectId')] }]
          : [];
        return page(values, q);
      },
    ],
    [
      'GET',
      /^\/issuetypescheme$/,
      ['id', 'expand', ...paged],
      (_, q) => page(named(typeSchemes, q, typeScheme), q),
    ],
    [
      'GET',
      /^\/issuetypescheme\/mapping$/,
      paged,
      (_, q) =>
        page(
          Object.entries(typeSchemes).flatMap(([s, x]) =>
            x.types.map((t) => ({ issueTypeSchemeId: s, issueTypeId: t })),
          ),
          q,
        ),
    ],
    [
      'DELETE',
      /^\/issuetypescheme\/(\d+)$/,
      [],
      ([, id]) => {
        if (exists(typeSchemes, id).isDefault) throw Error('Default scheme');
        if (Object.values(projects).some((p) => p.scheme === id)) throw Error('Scheme in use');
        delete typeSchemes[id];
      },
    ],
    [
      'DELETE',
      /^\/issuetypescheme\/(\d+)\/issuetype\/(\d+)$/,
      [],
      ([, s, t]) => {
        const x = exists(typeSchemes, s);
        if (!x.types.includes(t)) throw Error('Work type not in scheme');
        x.types = x.types.filter((v) => v !== t);
      },
    ],
    ['GET', /^\/issuetype$/, [], () => Object.keys(types).map((id) => ({ id, ...types[id] }))],
    ['GET', /^\/issuetype\/(\d+)$/, [], ([, id]) => (types[id] ? { id, ...types[id] } : null)],
    [
      'DELETE',
      /^\/issuetype\/(\d+)$/,
      [],
      ([, id]) => {
        exists(types, id);
        delete types[id];
        for (const x of Object.values(typeSchemes)) x.types = x.types.filter((t) => t !== id);
      },
    ],
    [
      'GET',
      /^\/screens$/,
      ['id', 'queryString', ...paged],
      (_, q) =>
        page(
          named(screens, q, (id) => ({
            id: Number(id),
            name: screens[id].name,
            description: screens[id].description,
          })),
          q,
        ),
    ],
    [
      'GET',
      /^\/screens\/(\d+)\/tabs$/,
      [],
      ([, id]) =>
        screens[id] ? screens[id].tabs.map((t) => ({ id: t.id, name: 'Field Tab' })) : null,
    ],
    [
      'GET',
      /^\/screens\/(\d+)\/tabs\/(\d+)\/fields$/,
      [],
      ([, s, t]) => tab(s, t).fields.map((id) => ({ id, name: id })),
    ],
    [
      'DELETE',
      /^\/screens\/(\d+)\/tabs\/(\d+)\/fields\/(\w+)$/,
      [],
      ([, s, t, f]) => {
        const x = tab(s, t);
        if (!x.fields.includes(f)) throw Error('Field not on tab');
        x.fields = x.fields.filter((v) => v !== f);
      },
    ],
    [
      'POST',
      /^\/screens\/(\d+)\/tabs\/(\d+)\/fields$/,
      [],
      ([, s, t], q, body) => {
        const x = tab(s, t);
        if (x.fields.includes(body.fieldId)) throw Error('Field already on tab');
        x.fields.push(body.fieldId);
        return { id: body.fieldId, name: body.fieldId };
      },
    ],
    [
      'DELETE',
      /^\/screens\/(\d+)$/,
      [],
      ([, id]) => {
        exists(screens, id);
        if (
          Object.values(screenSchemes).some((x) =>
            Object.values(x.screens).map(String).includes(id),
          )
        )
          throw inUse('Screen');
        delete screens[id];
      },
    ],
    [
      'GET',
      /^\/screenscheme$/,
      ['id', 'queryString', 'expand', ...paged],
      (_, q) => page(named(screenSchemes, q, screenScheme), q),
    ],
    [
      'DELETE',
      /^\/screenscheme\/(\d+)$/,
      [],
      ([, id]) => {
        exists(screenSchemes, id);
        if (usingScheme(id).length) throw inUse('Screen scheme');
        delete screenSchemes[id];
      },
    ],
    [
      'GET',
      /^\/issuetypescreenscheme\/mapping$/,
      ['issueTypeScreenSchemeId', ...paged],
      (_, q) => {
        const id = q.get('issueTypeScreenSchemeId');
        const rows = Object.entries(exists(itss, id).rows);
        return page(
          rows.map(([t, s]) => ({
            issueTypeScreenSchemeId: id,
            issueTypeId: t,
            screenSchemeId: s,
          })),
          q,
        );
      },
    ],
    [
      'PUT',
      /^\/issuetypescreenscheme\/(\d+)\/mapping\/default$/,
      [],
      ([, id], q, body) => {
        exists(screenSchemes, body.screenSchemeId);
        exists(itss, id).rows.default = body.screenSchemeId;
      },
    ],
    [
      'POST',
      /^\/issuetypescreenscheme\/(\d+)\/mapping\/remove$/,
      [],
      ([, id], q, body) => {
        const { rows } = exists(itss, id);
        for (const t of body.issueTypeIds) exists(rows, t);
        for (const t of body.issueTypeIds) delete rows[t];
      },
    ],
    ['GET', /^\/myself$/, [], () => ({ accountId: account })],
    [
      'GET',
      /^\/issuetypescreenscheme$/,
      ['id', 'queryString', ...paged],
      (_, q) =>
        page(
          named(itss, q, (id) => ({ id, name: itss[id].name, description: '' })),
          q,
        ),
    ],
    [
      'GET',
      /^\/issuetypescreenscheme\/(\d+)\/project$/,
      paged,
      ([, id], q) =>
        page(
          Object.keys(projects)
            .filter((p) => projects[p].itss === id)
            .map((p) => ({ id: p })),
          q,
        ),
    ],
    [
      'DELETE',
      /^\/issuetypescreenscheme\/(\d+)$/,
      [],
      ([, id]) => {
        exists(itss, id);
        if (Object.values(projects).some((p) => p.itss === id))
          throw inUse('Work type screen scheme');
        delete itss[id];
      },
    ],
    [
      'GET',
      /^\/workflowscheme$/,
      paged,
      (_, q) => page(Object.keys(workflowSchemes).map(workflowScheme), q),
    ],
    [
      'GET',
      /^\/workflowscheme\/(\d+)$/,
      [],
      ([, id]) => (workflowSchemes[id] ? workflowScheme(id) : null),
    ],
    [
      'GET',
      /^\/workflowscheme\/(\d+)\/projectUsages$/,
      ['maxResults'],
      ([, id], q) =>
        workflowSchemes[id]
          ? {
              workflowSchemeId: id,
              projects: {
                nextPageToken: null,
                values: Object.keys(projects)
                  .filter((p) => projects[p].workflowScheme === id)
                  .slice(0, Number(q.get('maxResults')))
                  .map((p) => ({ id: p })),
              },
            }
          : null,
    ],
    [
      'DELETE',
      /^\/workflowscheme\/(\d+)$/,
      [],
      ([, id]) => {
        exists(workflowSchemes, id);
        if (Object.values(projects).some((p) => p.workflowScheme === id))
          throw inUse('Workflow scheme');
        delete workflowSchemes[id];
      },
    ],
    [
      'GET',
      /^\/workflows\/search$/,
      ['queryString', ...paged],
      (_, q) =>
        page(
          named(workflows, q, (id) => ({ id, name: workflows[id].name })),
          q,
        ),
    ],
    [
      'GET',
      /^\/workflow\/([\w-]+)\/workflowSchemes$/,
      ['maxResults'],
      ([, id], q) =>
        workflows[id]
          ? {
              workflowId: id,
              workflowSchemes: {
                nextPageToken: null,
                values: usingWorkflow(id)
                  .slice(0, Number(q.get('maxResults')))
                  .map((s) => ({ id: s })),
              },
            }
          : null,
    ],
    [
      'DELETE',
      /^\/workflow\/([\w-]+)$/,
      [],
      ([, id]) => {
        exists(workflows, id);
        if (usingWorkflow(id).length) throw inUse('Workflow');
        delete workflows[id];
      },
    ],
    [
      'GET',
      /^\/filter\/search$/,
      ['filterName', ...paged],
      (_, q) =>
        page(
          Object.keys(filters)
            .filter((id) => filters[id].name.includes(q.get('filterName')))
            .map((id) => ({ id, name: filters[id].name })),
          q,
        ),
    ],
    [
      'GET',
      /^\/filter\/(\d+)$/,
      ['expand'],
      ([, id]) =>
        filters[id]
          ? {
              id,
              name: filters[id].name,
              jql: filters[id].jql,
              owner: { accountId: filters[id].owner },
            }
          : null,
    ],
    [
      'DELETE',
      /^\/filter\/(\d+)$/,
      [],
      ([, id]) => {
        exists(filters, id);
        delete filters[id];
      },
    ],
  ];
  async function api(path, method = 'GET', body) {
    calls.push(`${method} ${path}`);
    const url = new URL(path, 'https://jira.invalid');
    for (const [m, pattern, allowed, handle] of routes) {
      const match = m === method && url.pathname.match(pattern);
      if (!match) continue;
      for (const key of url.searchParams.keys())
        if (!allowed.includes(key)) throw Error(`Unexpected parameter ${key} in ${path}`);
      if (allowed.includes('maxResults') !== url.searchParams.has('maxResults'))
        throw Error(`Unpaged ${path}`);
      const write = method !== 'GET' && path !== '/search/jql';
      if (write) writes.push(`${method} ${path}${body ? ` ${JSON.stringify(body)}` : ''}`);
      if (write && drop === `${method} ${path}`) {
        drop = undefined;
        throw Error('Fixture API request failed');
      }
      if (write && refuse === `${method} ${path}`) {
        refuse = undefined;
        throw Object.assign(Error(`Fixture API ${method} failed (HTTP 429)`), {
          definitiveRejection: true,
        });
      }
      const value = structuredClone(handle(match, url.searchParams, body) ?? null);
      if (write && lose === `${method} ${path}`) {
        lose = undefined;
        throw Error('Fixture API response lost');
      }
      return value;
    }
    throw Error(`Fake Jira has no ${method} ${path}`);
  }
  return { api, calls, writes };
}
