// In-memory Jira for the setup runner's cleanup: only the REST endpoints it uses, paged two at a
// time. Anything else throws, so a new request in cleanup fails its test until it is modelled.
//
// World: { projects, typeSchemes, types, screens, screenSchemes, itss }, each keyed by id.
// projects: { key, description, scheme, itss }; typeSchemes: { name, isDefault?, types: [id] };
// types: { name, description, hierarchyLevel, subtask }; screens: { name, description,
// tabs: [{ id, fields: [fieldId] }] }; screenSchemes: { name, description, screens };
// itss: { name, rows: { [workTypeId | 'default']: screenSchemeId } }.
// `lose` names one write ('METHOD path') that Jira applies but whose response is lost; `drop` one
// that fails without reaching Jira.
export function fakeJira(world, { lose, drop } = {}) {
  const calls = [];
  const writes = [];
  const { projects, typeSchemes, types, screens, screenSchemes, itss } = world;
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
  const routes = [
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
          throw Error('Screen in use');
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
        if (usingScheme(id).length) throw Error('Screen scheme in use');
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
