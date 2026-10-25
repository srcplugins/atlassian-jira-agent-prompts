import {
  createSettings,
  reloadInput,
  screenTypesInput,
  type ScreenInfo,
  type ScreenRecord,
  type SettingsPorts,
  type SettingsRecord,
} from './settings';
import {
  createConfigurationBatch,
  type BatchPorts,
  type BatchRecord,
  type InventoryProject,
} from './configuration-batch';
import { resolveSafely } from './shared/resolver.mjs';
import {
  JiraHttpError,
  isDefinitiveRejection,
  projectContext,
  readWithRetries,
  requireEmptyPayload,
  requireProjectKey,
  requireSoftwareSpace,
  rovoAccountId,
} from './shared/jira.mjs';
import {
  createService,
  JiraRejected,
  JiraUnavailable,
  StorageUnavailable,
  limited,
  numeric,
  UserError,
  type Context,
  type Issue,
  type Ports,
  type Prompt,
  type Stored,
} from './service';
import { DescriptionError } from './description';
import { storageEntity } from './names';
import { licensed, requireLicense, type AppLicense } from './license';
interface Sdk {
  Resolver: typeof import('@forge/resolver').default;
  api: typeof import('@forge/api').default;
  route: typeof import('@forge/api').route;
  kvs: typeof import('@forge/kvs').kvs;
  Filter: typeof import('@forge/kvs').Filter;
  FilterConditions: typeof import('@forge/kvs').FilterConditions;
  fieldType(): string;
  /** This invocation's environment and license, from the Forge runtime. */
  appContext(): AppLicense;
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
const rateLimited = 'Jira is limiting requests. Wait a moment, then try again.';
// Jira's English stop words and text-search operators (compared lowercased).
const reservedWords = new Set(
  'a an and are as at be but by for if in into is it no not of on or such that the their then there these they this to was will with'.split(
    ' ',
  ),
);
/** Converts a documented rejection of a write into JiraRejected; other failures pass through
 * unchanged and stay uncertain. */
function classifyWrite(
  error: unknown,
  operation: Parameters<typeof isDefinitiveRejection>[0],
  message: (status: number) => string,
): never {
  if (error instanceof JiraHttpError && isDefinitiveRejection(operation, error.status))
    throw new JiraRejected(
      error.status,
      error.status === 429 ? rateLimited : message(error.status),
    );
  throw error;
}
/** One exact work item key such as TEAM-42. Jira keys are case-insensitive, so a key typed in
 * lower case is upper-cased; anything else, including a numeric ID, is refused. */
function exactKey(value: unknown, message: string) {
  const key = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!/^[A-Z][A-Z0-9_]{1,30}-[1-9][0-9]{0,19}$/.test(key)) throw new UserError(message);
  return key;
}
/** IDs in groups of 100, the most Jira returns a page. */
function pages(ids: string[]) {
  return Array.from({ length: Math.ceil(ids.length / 100) }, (_, i) =>
    ids.slice(i * 100, i * 100 + 100),
  );
}
/** A query naming each ID (`id=1&id=2`), one page of up to 100. */
function byIds(ids: string[]) {
  return new URLSearchParams([...ids.map((id) => ['id', id]), ['maxResults', '100']]);
}
/** The trusted space (and, on a work item, its ID) from a field or search resolver context. */
function context(raw: unknown): Context {
  const { accountId, projectId } = projectContext(raw);
  const issue = (raw as { extension: Record<string, unknown> }).extension.issue;
  return { accountId, projectId, ...(record(issue) ? { issueId: numeric(issue.id) } : {}) };
}
/** Reads one operational record. A failing storage call is reported as storage being unavailable,
 * so callers can tell an outage from a defect. */
async function readState<T>(kvs: Sdk['kvs'], key: string) {
  try {
    return await kvs.entity<T>(storageEntity).get(key);
  } catch {
    throw new StorageUnavailable('App storage is unavailable. Try again shortly.');
  }
}
function requester({ api }: Sdk, deadline?: number) {
  /** A read (GET, or `read` for a read-only POST such as search) is tried up to three times when
   * Jira is briefly unavailable, but never past `deadline`; a write is sent once. */
  async function request(
    path: ReturnType<Sdk['route']>,
    method = 'GET',
    body?: unknown,
    read = method === 'GET',
  ) {
    if (!read) return send(path, method, body);
    return readWithRetries(
      () => send(path, method, body),
      (error) =>
        error instanceof JiraUnavailable || (error instanceof JiraHttpError && error.status >= 500),
      deadline,
    );
  }
  async function send(path: ReturnType<Sdk['route']>, method: string, body?: unknown) {
    let response;
    try {
      response = await api.asUser().requestJira(path, {
        method,
        headers: {
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new JiraUnavailable('Jira connection failed. No write was retried.');
    }
    if (!response.ok)
      throw new JiraHttpError(
        response.status,
        response.status === 429
          ? rateLimited
          : `Jira request failed (HTTP ${response.status}). Check your access, then try again.`,
      );
    if (response.status === 204) return null;
    try {
      return await response.json();
    } catch {
      throw new UserError('Jira returned unreadable data.');
    }
  }
  return request;
}
export function createPorts({ api, route, kvs, Filter, FilterConditions, fieldType }: Sdk): Ports {
  const request = requester({ api, route, kvs, Filter, FilterConditions, fieldType } as Sdk);
  let fieldPromise: Promise<string> | undefined;
  // One space settings record serves three lookups; read it once per request. These ports never
  // write it (configuration writes go through the settings ports), so the copy cannot go stale.
  const settings = new Map<string, Promise<SettingsRecord | undefined>>();
  const spaceSettings = (project: string) => {
    if (!settings.has(project))
      settings.set(project, readState<SettingsRecord>(kvs, `config-${project}`));
    return settings.get(project)!;
  };
  return {
    refreshAfterSave: async (project) =>
      (await spaceSettings(project))?.data.refreshAfterSave === true,
    config: async (project) => (await spaceSettings(project))?.data.type,
    retainedTypes: async (project) => (await spaceSettings(project))?.data.previousTypes ?? [],
    project: async (id) => {
      const value = await request(route`/rest/api/3/project/${id}`);
      if (!value || value.id !== id || !Array.isArray(value.issueTypes))
        throw new UserError('Incomplete space data.');
      return value;
    },
    allowed: async (project, permission, issue) => {
      const value = await request(
        issue
          ? route`/rest/api/3/mypermissions?projectId=${project}&issueId=${issue}&permissions=${permission}`
          : route`/rest/api/3/mypermissions?projectId=${project}&permissions=${permission}`,
      );
      if (value?.permissions?.[permission]?.havePermission !== true)
        throw new UserError(
          `This needs the Jira permission ${permission === 'ADMINISTER' ? 'Administer Jira' : 'Edit work items'}.`,
        );
    },
    field: () => {
      fieldPromise ??= (async () => {
        const fields = await request(route`/rest/api/3/field`);
        if (!Array.isArray(fields)) throw new UserError('Incomplete Jira field data.');
        const matches = fields.filter((f) => f.schema?.custom === fieldType());
        if (matches.length !== 1 || !/^customfield_[1-9]\d*$/.test(matches[0].id))
          throw new UserError(
            'The Agent Prompts field could not be identified in Jira. Check that the app is installed and its field is not in the trash.',
          );
        return matches[0].id;
      })();
      return fieldPromise;
    },
    search: async (project, type, input) => {
      const query = input.query?.trim() ?? '';
      // Treat input as text, never as executable JQL/Lucene syntax. A query shaped like a work
      // item key is first looked up as a key; words use ANDed, escaped prefix terms in Summary.
      // A key lookup finds at most one prompt, so a later page always continues a word search.
      const key = !input.cursor && /^[A-Z][A-Z0-9_]*-[1-9]\d*$/i.test(query);
      // Combining marks (Devanagari vowel signs, decomposed accents) belong to their word.
      const tokens = (query.match(/[\p{L}\p{M}\p{N}_]+/gu) ?? []).map((word) => word.toLowerCase());
      if (query && !tokens.length) return { prompts: [], incomplete: false };
      // Jira does not index stop words and treats operator words specially: alone they match
      // everything, but inside a multi-word query their clause matches nothing. Drop them; a
      // query of only such words lists the newest prompts, as Jira's own search does.
      const words = tokens.filter((word) => !reservedWords.has(word));
      // One text clause per word, ANDed in JQL. The prefix matches a word as typed; the bare
      // word matches Jira's stemmed index, where "tests*" misses a stored "test".
      const wordClause = words.length
        ? ` AND ${words
            .map(
              (word) =>
                `(summary ~ ${JSON.stringify(`${word}*`)} OR summary ~ ${JSON.stringify(word)})`,
            )
            .join(' AND ')}`
        : '';
      // A prompt in a Done-category status is retired: search never offers it, and a work
      // item that already uses it reads it by ID.
      const find = (clause: string) =>
        request(
          route`/rest/api/3/search/jql`,
          'POST',
          {
            jql: `project = ${numeric(project)} AND issuetype = ${numeric(type)}${clause} AND statusCategory != Done ORDER BY created DESC, key DESC`,
            fields: ['summary', 'project', 'issuetype'],
            maxResults: input.limit,
            ...(input.cursor ? { nextPageToken: input.cursor } : {}),
          },
          true,
        );
      // Jira answers 400 for a key that does not exist or is not visible, and for text it
      // cannot parse. Either way nothing matches; it is not an access failure.
      const noMatch = (error: unknown) => error instanceof JiraHttpError && error.status === 400;
      let value;
      try {
        if (key)
          value = await find(` AND key = ${JSON.stringify(query.toUpperCase())}`).catch(
            (error: unknown) => {
              if (noMatch(error)) return undefined;
              throw error;
            },
          );
        // Words can look like a key ("GPT-4", "UTF-8"): when no prompt has that key, the same
        // query is searched as words.
        if (!key || value === undefined || (Array.isArray(value.issues) && !value.issues.length))
          value = await find(wordClause);
      } catch (error) {
        // A follow-up page (expired or invalid cursor) is a failed page, never the end of results.
        if (query && !input.cursor && noMatch(error)) return { prompts: [], incomplete: false };
        throw error;
      }
      if (
        !Array.isArray(value?.issues) ||
        typeof value.isLast !== 'boolean' ||
        value.issues.length > input.limit
      )
        throw new UserError('Incomplete Jira search data. Search again.');
      const prompts: Prompt[] = value.issues.map((issue: Issue) => {
        if (
          typeof issue?.key !== 'string' ||
          typeof issue.fields?.summary !== 'string' ||
          issue.fields.project?.id !== project ||
          issue.fields.issuetype?.id !== type
        )
          throw new UserError('Prompt search scope changed. Search again.');
        return { id: numeric(issue.id), key: issue.key, name: issue.fields.summary };
      });
      if (new Set(prompts.map((p) => p.id)).size !== prompts.length)
        throw new UserError('Jira returned repeated search results. Search again.');
      if (
        !value.isLast &&
        (typeof value.nextPageToken !== 'string' ||
          !value.nextPageToken ||
          value.nextPageToken.length > 8192 ||
          value.nextPageToken === input.cursor)
      )
        throw new UserError('Invalid Jira search cursor. Search again.');
      return {
        prompts,
        incomplete: !value.isLast,
        ...(!value.isLast ? { nextCursor: value.nextPageToken } : {}),
      };
    },
    issue: async (id, field) => {
      if (!/^(?:[1-9]\d{0,19}|[A-Z][A-Z0-9_]{1,30}-[1-9]\d*)$/.test(id))
        throw new UserError('Invalid work item key.');
      const fields = `project,issuetype,summary,description,updated,status,security${field ? `,${field}` : ''}`;
      const value = await request(route`/rest/api/3/issue/${id}?fields=${fields}`);
      if (
        !value ||
        typeof value.key !== 'string' ||
        typeof value.fields?.summary !== 'string' ||
        typeof value.fields?.updated !== 'string' ||
        !('description' in value.fields)
      )
        throw new UserError('Incomplete work item data.');
      numeric(value.id);
      numeric(value.fields.project?.id);
      numeric(value.fields.issuetype?.id);
      return value as Issue;
    },
    update: async (id, fields) => {
      try {
        await request(route`/rest/api/3/issue/${id}`, 'PUT', { fields });
      } catch (e) {
        // Documented rejections (and 429) were not applied. Other HTTP failures, failed
        // transports and unreadable successes stay uncertain.
        classifyWrite(e, 'issue-edit', (status) =>
          status === 400
            ? 'Jira rejected this save (HTTP 400). Check that the Agent Prompts field is available on this work item and that the description is not too long, then save again.'
            : `Jira rejected this save (HTTP ${status}). Review your selection and save again.`,
        );
      }
    },
    get: (id) => readState<Stored>(kvs, `issue-${id}`),
    cas: async (id, revision, data) => {
      if (Buffer.byteLength(JSON.stringify(data), 'utf8') > 190_000)
        throw new UserError('Operational state is too large.');
      try {
        await kvs
          .transact()
          .set(
            `issue-${id}`,
            { revision: revision + 1, data },
            {
              entityName: storageEntity,
              conditions: new Filter<Stored>().and(
                'revision',
                revision === 0 ? FilterConditions.notExists() : FilterConditions.equalTo(revision),
              ),
            },
          )
          .execute();
      } catch {
        throw new UserError(
          'Another save is running or storage is unavailable. Reopen this field to check saved state.',
        );
      }
    },
  };
}
export function createSettingsPorts(sdk: Sdk): SettingsPorts {
  const { route, kvs, Filter, FilterConditions } = sdk;
  // One resolver invocation may run for 25 seconds. Reads that find who uses a screen stop after
  // 12, so a blocked review comes back instead of a timeout; writes need the rest (`timeLeft`).
  // No read is tried again past 22 seconds, so the step's last storage writes still fit.
  const started = Date.now();
  const request = requester(sdk, started + 22_000);
  const late = () => Date.now() > started + 12_000;
  // Who uses a screen: Jira has no direct lookup, so every screen scheme is listed once per
  // request with the work type screen schemes using it, then those schemes' spaces.
  type Read<T> = Promise<T & { complete: boolean; late?: boolean }>;
  let screenSchemeList:
    Read<{ schemes: { id: string; screens: string[]; itss?: string[] }[] }> | undefined;
  let mappingScan: Read<{ users: Map<string, string[]> }> | undefined;
  const itssProjects: Record<
    string,
    Read<{ projects: { id: string; key?: string; name?: string }[] }>
  > = {};
  return {
    get: (project) => readState<SettingsRecord>(kvs, `config-${project}`),
    cas: async (project, revision, data, screen, run) => {
      const condition = (revision: number) => ({
        entityName: storageEntity,
        conditions: new Filter<SettingsRecord>().and(
          'revision',
          revision === 0 ? FilterConditions.notExists() : FilterConditions.equalTo(revision),
        ),
      });
      try {
        // A space's setup and the screen ownership record it changes commit together.
        let transaction = kvs
          .transact()
          .set(
            `config-${project}`,
            { revision: revision + 1, data: JSON.parse(JSON.stringify(data)) },
            condition(revision),
          );
        if (screen)
          transaction = screen.data
            ? transaction.set(
                `screen-${screen.id}`,
                { revision: screen.revision + 1, data: JSON.parse(JSON.stringify(screen.data)) },
                condition(screen.revision),
              )
            : transaction.delete(`screen-${screen.id}`, condition(screen.revision));
        if (run !== undefined) transaction = transaction.check(batchStorageKey, condition(run));
        await transaction.execute();
      } catch {
        throw new UserError(
          'Configuration changed or storage is unavailable. Check the space again.',
        );
      }
    },
    types: async () => {
      const value = await request(route`/rest/api/3/issuetype`);
      // Team-managed spaces each bring their own (scoped) types, so only global types are capped.
      if (
        !Array.isArray(value) ||
        value.length > 50_000 ||
        value.filter((t) => !t?.scope).length > 2000 ||
        value.some(
          (t) =>
            !t ||
            typeof t.name !== 'string' ||
            typeof t.subtask !== 'boolean' ||
            (t.hierarchyLevel !== undefined && !Number.isInteger(t.hierarchyLevel)),
        )
      )
        throw new UserError('Incomplete or oversized work type list.');
      return value.map((t) => ({
        id: numeric(t.id),
        name: t.name,
        subtask: t.subtask,
        ...(t.hierarchyLevel !== undefined ? { hierarchyLevel: t.hierarchyLevel } : {}),
        ...(t.scope ? { scope: t.scope } : {}),
      }));
    },
    scheme: async (project) => {
      const result = await request(route`/rest/api/3/issuetypescheme/project?projectId=${project}`);
      if (result?.isLast !== true || result.values?.length !== 1)
        throw new UserError('Could not identify the space’s work type scheme.');
      const id = numeric(result.values[0].issueTypeScheme?.id);
      const expanded = await request(route`/rest/api/3/issuetypescheme?id=${id}&expand=projects`);
      const item = expanded?.values?.[0];
      if (
        expanded?.isLast !== true ||
        expanded.values.length !== 1 ||
        item?.id !== id ||
        typeof item.name !== 'string'
      )
        throw new UserError('Incomplete scheme data.');
      // Jira embeds one page of the scheme's spaces. When it holds only part of them, the scheme
      // can still be used as it is, but the app never adds a type to it (see plan).
      if (
        !item.isDefault &&
        (item.projects?.isLast !== true ||
          !Array.isArray(item.projects.values) ||
          item.projects.values.length > 1000 ||
          (item.projects.total !== undefined &&
            item.projects.total !== item.projects.values.length))
      )
        return {
          id,
          name: item.name,
          isDefault: false,
          projectIds: [],
          projects: [],
          complete: false,
        };
      const projects = item.isDefault
        ? []
        : item.projects.values
            .map((p: { id: string; key?: unknown; name?: unknown }) => ({
              id: numeric(p.id),
              ...(typeof p.key === 'string' ? { key: p.key } : {}),
              ...(typeof p.name === 'string' ? { name: p.name } : {}),
            }))
            .sort((a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id));
      if (
        !item.isDefault &&
        (new Set(projects.map((p: { id: string }) => p.id)).size !== projects.length ||
          !projects.some((p: { id: string }) => p.id === project))
      )
        throw new UserError(
          'The scheme’s space list is inconsistent; no automatic changes are available.',
        );
      return {
        id,
        name: item.name,
        isDefault: item.isDefault === true,
        projectIds: projects.map((p: { id: string }) => p.id),
        projects,
      };
    },
    create: async (name) => {
      let value;
      try {
        value = await request(route`/rest/api/3/issuetype`, 'POST', {
          name,
          hierarchyLevel: 0,
          description: 'Reusable instructions managed through Agent Prompts for Jira.',
        });
      } catch (e) {
        classifyWrite(e, 'issuetype-create', (status) =>
          status === 409
            ? 'Jira rejected creating the type (HTTP 409): a type with that name may already exist. Nothing was changed; select the existing type instead.'
            : `Jira rejected creating the type (HTTP ${status}). Nothing was changed.`,
        );
      }
      // A 2xx without a readable ID is not a rejection: the type may exist.
      return numeric(value?.id);
    },
    attach: async (scheme, type) => {
      try {
        await request(route`/rest/api/3/issuetypescheme/${scheme}/issuetype`, 'PUT', {
          issueTypeIds: [type],
        });
      } catch (e) {
        classifyWrite(
          e,
          'issuetypescheme-add',
          (status) =>
            `Jira rejected adding the type to the space's scheme (HTTP ${status}). The scheme was not changed.`,
        );
      }
    },
    // Jira returns at most 200 create fields a page; past 1,000 the list is reported incomplete.
    createFields: async (project, type) => {
      const fields: string[] = [];
      for (let start = 0; start < 1000;) {
        const value = await request(
          route`/rest/api/3/issue/createmeta/${project}/issuetypes/${type}?startAt=${start}&maxResults=200`,
        );
        if (!Array.isArray(value?.fields)) throw new UserError('Create fields are incomplete.');
        fields.push(...value.fields.map((f: { fieldId: string }) => f.fieldId));
        if (
          typeof value.total === 'number' ? fields.length >= value.total : value.fields.length < 200
        )
          return fields;
        if (!value.fields.length) throw new UserError('Create fields are incomplete.');
        start += value.fields.length;
      }
      throw new UserError('Create fields are incomplete.');
    },
    screenUses: async (project, uses) => {
      const assigned = await request(
        route`/rest/api/3/issuetypescreenscheme/project?projectId=${project}`,
      );
      if (
        assigned?.isLast !== true ||
        !Array.isArray(assigned.values) ||
        assigned.values.length !== 1 ||
        !assigned.values[0]?.projectIds?.includes?.(project)
      )
        throw new UserError('Could not identify the space’s screen scheme.');
      const scheme = numeric(assigned.values[0].issueTypeScreenScheme?.id);
      const rows = new Map<string, string>();
      for (let start = 0, page = 0; ; page++) {
        const value =
          page < 10
            ? await request(
                route`/rest/api/3/issuetypescreenscheme/mapping?issueTypeScreenSchemeId=${scheme}&startAt=${start}&maxResults=100`,
              )
            : undefined;
        if (
          !Array.isArray(value?.values) ||
          value.startAt !== start ||
          typeof value.isLast !== 'boolean' ||
          (!value.isLast && !value.values.length)
        )
          throw new UserError('The space’s screen scheme could not be read completely.');
        for (const row of value.values) {
          const type = row?.issueTypeId === 'default' ? 'default' : numeric(row?.issueTypeId);
          if (numeric(row.issueTypeScreenSchemeId) !== scheme || rows.has(type))
            throw new UserError('The space’s screen scheme is inconsistent.');
          rows.set(type, numeric(row.screenSchemeId));
        }
        if (value.isLast) break;
        start += value.values.length;
      }
      const screenSchemes = new Map<string, Record<string, string>>();
      const chosen = uses.map((u) => {
        const row = (u.type && rows.get(u.type)) || rows.get('default');
        if (!row) throw new UserError('The space’s screen scheme has no default screens.');
        return row;
      });
      for (const ids of pages([...new Set(chosen)])) {
        const value = await request(route`/rest/api/3/screenscheme?${byIds(ids)}`);
        if (
          value?.isLast !== true ||
          !Array.isArray(value.values) ||
          value.values.length !== ids.length
        )
          throw new UserError('A screen scheme could not be read.');
        for (const item of value.values) {
          const id = String(item?.id);
          if (!ids.includes(id) || !record(item.screens))
            throw new UserError('A screen scheme could not be read.');
          screenSchemes.set(
            id,
            Object.fromEntries(
              ['default', 'create', 'edit', 'view']
                .filter((op) => item.screens[op] !== undefined)
                .map((op) => [op, numeric(String(item.screens[op]))]),
            ),
          );
        }
      }
      return uses.map((u, i) => {
        const screens = screenSchemes.get(chosen[i]!)!;
        const screen = screens[u.op] ?? screens.default;
        if (!screen) throw new UserError('A screen scheme has no default screen.');
        return screen;
      });
    },
    // Names come from one bulk read and where the field sits from one field read, so only a
    // screen without the field (for its first tab) or one in `full` reads its tabs. Reads stop at
    // the review cutoff; reads confirming writes may also use the time set aside for the writes.
    screens: async (ids, field, full = [], confirm = false) => {
      const due = () => {
        if (confirm ? Date.now() > started + 22_000 : late())
          throw new JiraUnavailable(
            'The screens could not all be read in time. Review this space again.',
          );
      };
      const names = new Map<string, string>();
      for (const chunk of pages(ids)) {
        due();
        const value = await request(route`/rest/api/3/screens?${byIds(chunk)}`);
        if (value?.isLast !== true || !Array.isArray(value.values))
          throw new UserError('A screen could not be read.');
        for (const item of value.values) {
          if (!chunk.includes(String(item?.id)) || typeof item.name !== 'string')
            throw new UserError('A screen could not be read.');
          names.set(String(item.id), item.name);
        }
      }
      // A screen deleted in Jira is reported as missing, so its stale ownership can be dropped.
      const present = ids.filter((id) => names.has(id));
      const placed = present.some((id) => !full.includes(id))
        ? await fieldTabs(field, due)
        : new Map<string, string>();
      return limited(ids, async (id): Promise<ScreenInfo | undefined> => {
        const name = names.get(id);
        if (name === undefined) return undefined;
        const tab = placed.get(id);
        if (tab && !full.includes(id)) return { id, name, tabs: [{ id: tab, fields: [field] }] };
        due();
        const tabs = await request(route`/rest/api/3/screens/${id}/tabs`);
        if (!Array.isArray(tabs) || tabs.length > 50)
          throw new UserError('A screen’s tabs could not be read.');
        const tabIds = tabs.map((t) => numeric(String(t?.id)));
        if (!full.includes(id))
          return { id, name, tabs: tabIds.map((t) => ({ id: t, fields: [] })) };
        const read = await limited(tabIds, async (tabId) => {
          due();
          const fields = await request(route`/rest/api/3/screens/${id}/tabs/${tabId}/fields`);
          if (!Array.isArray(fields) || fields.some((f) => typeof f?.id !== 'string'))
            throw new UserError('A screen’s fields could not be read.');
          return { id: tabId, fields: fields.map((f: { id: string }) => f.id) };
        });
        return { id, name, tabs: read };
      });
    },
    screenImpact: async (screen) => {
      screenSchemeList ??= listScreenSchemes();
      const list = await screenSchemeList;
      const matching = list.schemes.filter((s) => s.screens.includes(screen));
      let complete = list.complete;
      let timedOut = !!list.late;
      const itss = new Set(matching.flatMap((s) => s.itss ?? []));
      // The expansion is one page; the full mapping lists the rest.
      if (matching.some((s) => !s.itss)) {
        mappingScan ??= scanMappings();
        const mapping = await mappingScan;
        complete &&= mapping.complete;
        timedOut ||= !!mapping.late;
        for (const s of matching)
          if (!s.itss) for (const id of mapping.users.get(s.id) ?? []) itss.add(id);
      }
      const projects = new Map<string, { id: string; key?: string; name?: string }>();
      const read = await limited([...itss], (id) => (itssProjects[id] ??= projectsOf(id)));
      for (const value of read) {
        complete &&= value.complete;
        timedOut ||= !!value.late;
        for (const p of value.projects) projects.set(p.id, p);
      }
      if (projects.size > 1000) complete = false;
      return {
        projects: [...projects.values()].sort((a, b) => a.id.localeCompare(b.id)),
        complete,
        ...(!complete && timedOut ? { timedOut } : {}),
      };
    },
    addScreenField: async (screen, tab, field) => {
      try {
        await request(route`/rest/api/3/screens/${screen}/tabs/${tab}/fields`, 'POST', {
          fieldId: field,
        });
      } catch (e) {
        classifyWrite(
          e,
          'screen-field-add',
          (status) =>
            `Jira rejected adding a field to a screen (HTTP ${status}). Nothing was changed.`,
        );
      }
    },
    removeScreenField: async (screen, tab, field) => {
      try {
        await request(route`/rest/api/3/screens/${screen}/tabs/${tab}/fields/${field}`, 'DELETE');
      } catch (e) {
        classifyWrite(
          e,
          'screen-field-remove',
          (status) =>
            `Jira rejected removing a field from a screen (HTTP ${status}). Nothing was changed.`,
        );
      }
    },
    screenRecord: (screen) => readState<ScreenRecord>(kvs, `screen-${screen}`),
    configuring: async (project) => {
      const run = await readState<BatchRecord>(kvs, batchStorageKey);
      return {
        revision: run?.revision ?? 0,
        changing:
          run?.data.status === 'running' && run.data.entries[run.data.index]?.projectId === project,
      };
    },
    timeLeft: () => started + 22_000 - Date.now(),
  };
  /** Where `field` sits: screen ID to tab ID, across every screen that has it. */
  async function fieldTabs(field: string, due: () => void) {
    if (!/^customfield_[1-9]\d*$/.test(field)) throw new UserError('Invalid prompt field.');
    const tabs = new Map<string, string>();
    // Ten pages, like the screen scheme mapping: a thousand screens is past any review budget.
    for (let start = 0, page = 0; ; page++) {
      if (page >= 10)
        throw new UserError('Too many screens use the Agent Prompts field to review at once.');
      due();
      const value = await request(
        route`/rest/api/3/field/${field}/screens?startAt=${start}&maxResults=100&expand=tab`,
      );
      if (
        !Array.isArray(value?.values) ||
        value.startAt !== start ||
        typeof value.isLast !== 'boolean' ||
        (!value.isLast && !value.values.length)
      )
        throw new UserError('The screens using the Agent Prompts field could not be read.');
      for (const item of value.values) {
        if (item?.tab?.id === undefined)
          throw new UserError('The screens using the Agent Prompts field could not be read.');
        tabs.set(numeric(String(item.id)), numeric(String(item.tab.id)));
      }
      if (value.isLast) return tabs;
      start += value.values.length;
    }
  }
  /** Every screen scheme with its screens and, when Jira listed them all, the work type screen
   * schemes using it (none when the expansion is omitted). The first page gives the total, so the
   * rest are read four at a time, each starting where a page as long as the first would end. */
  async function listScreenSchemes() {
    const schemes = new Map<string, { id: string; screens: string[]; itss?: string[] }>();
    const page = async (start: number) => {
      if (late()) return undefined;
      const value = await request(
        route`/rest/api/3/screenscheme?startAt=${start}&maxResults=100&expand=issueTypeScreenSchemes`,
      );
      if (
        !Array.isArray(value?.values) ||
        value.startAt !== start ||
        typeof value.isLast !== 'boolean' ||
        (!value.isLast && !value.values.length)
      )
        throw new UserError('Screen schemes could not be read completely.');
      for (const item of value.values) {
        const nested = item?.issueTypeScreenSchemes;
        if (
          !record(item?.screens) ||
          (nested !== undefined &&
            (!Array.isArray(nested?.values) || typeof nested.isLast !== 'boolean'))
        )
          throw new UserError('A screen scheme could not be read.');
        const id = numeric(String(item.id));
        schemes.set(id, {
          id,
          screens: Object.values(item.screens).map((s) => numeric(String(s))),
          ...(nested === undefined
            ? { itss: [] }
            : nested.isLast
              ? { itss: nested.values.map((i: { id?: unknown }) => numeric(String(i?.id))) }
              : {}),
        });
      }
      return {
        isLast: value.isLast as boolean,
        next: start + value.values.length,
        total: value.total as unknown,
      };
    };
    const done = (complete: boolean) => ({
      schemes: [...schemes.values()],
      complete,
      ...(complete ? {} : { late: true }),
    });
    let read = await page(0);
    if (!read) return done(false);
    if (!read.isLast && typeof read.total === 'number' && read.total > read.next) {
      const starts: number[] = [];
      for (let start = read.next; start < read.total; start += read.next) starts.push(start);
      const rest = await limited(starts, page);
      if (rest.some((r) => !r)) return done(false);
      // Jira may return a shorter page than the first, leaving schemes between that page and the
      // next start unread: the scan goes on page by page from the first such gap, and a scheme
      // read twice is kept once.
      const gap = rest.findIndex((r, i) => i < starts.length - 1 && r!.next < starts[i + 1]!);
      read = gap === -1 ? rest.at(-1)! : { ...rest[gap]!, isLast: false };
    }
    // Without a total, or when schemes were added meanwhile, the rest is read page by page.
    while (!read.isLast) {
      read = await page(read.next);
      if (!read) return done(false);
    }
    // A scheme added during the scan shifts later ones to later offsets, where one can be missed:
    // fewer schemes than Jira counts is never a complete list, but a new scan can be. A deletion
    // can hide one without changing the count, but only in one scan, so the fresh review before
    // writes then differs.
    if (typeof read.total === 'number' && schemes.size < read.total)
      throw new JiraUnavailable(
        'Screen schemes changed while being read. Review this space again.',
      );
    return done(true);
  }
  /** Every work type screen scheme row, grouped by screen scheme. */
  async function scanMappings(): Read<{ users: Map<string, string[]> }> {
    const users = new Map<string, string[]>();
    for (let start = 0; ;) {
      if (late()) return { users, complete: false, late: true };
      const value = await request(
        route`/rest/api/3/issuetypescreenscheme/mapping?startAt=${start}&maxResults=100`,
      );
      if (
        !Array.isArray(value?.values) ||
        value.startAt !== start ||
        typeof value.isLast !== 'boolean' ||
        (!value.isLast && !value.values.length)
      )
        throw new UserError('Screen schemes could not be read completely.');
      for (const row of value.values) {
        const scheme = numeric(String(row?.screenSchemeId));
        const itss = numeric(String(row?.issueTypeScreenSchemeId));
        const known = users.get(scheme) ?? [];
        if (!known.includes(itss)) users.set(scheme, [...known, itss]);
      }
      if (value.isLast) return { users, complete: true };
      start += value.values.length;
    }
  }
  async function projectsOf(
    itss: string,
  ): Read<{ projects: { id: string; key?: string; name?: string }[] }> {
    const projects = [];
    for (let start = 0, page = 0; page < 10; page++) {
      if (late()) return { projects, complete: false, late: true };
      const value = await request(
        route`/rest/api/3/issuetypescreenscheme/${itss}/project?startAt=${start}&maxResults=100`,
      );
      if (
        !Array.isArray(value?.values) ||
        value.startAt !== start ||
        typeof value.isLast !== 'boolean' ||
        (!value.isLast && !value.values.length)
      )
        throw new UserError('The spaces using a screen could not be read completely.');
      for (const p of value.values)
        projects.push({
          id: numeric(String(p?.id)),
          ...(typeof p.key === 'string' ? { key: p.key } : {}),
          ...(typeof p.name === 'string' ? { name: p.name } : {}),
        });
      if (value.isLast) return { projects, complete: true };
      start += value.values.length;
    }
    return { projects, complete: false };
  }
}
// Storage key of the unfinished multi-space configuration.
const batchStorageKey = 'configuration-batch';
/** The batch ports plus the space inventory, which only the health view reads. */
export function createBatchPorts(
  sdk: Sdk,
): BatchPorts & { projects(): Promise<{ projects: InventoryProject[]; incomplete: boolean }> } {
  const request = requester(sdk);
  const { route, kvs, Filter, FilterConditions } = sdk;
  return {
    admin: async () => {
      const value = await request(route`/rest/api/3/mypermissions?permissions=ADMINISTER`);
      if (value?.permissions?.ADMINISTER?.havePermission !== true)
        throw new UserError('This needs the Jira permission Administer Jira.');
    },
    projects: async () => {
      const projects: InventoryProject[] = [];
      const seen = new Set<string>();
      let start = 0;
      // Stay well inside the resolver's 25-second limit and report a partial inventory instead
      // of timing out.
      const deadline = Date.now() + 15_000;
      for (let page = 0; page < 20; page++) {
        if (page && Date.now() > deadline) return { projects, incomplete: true };
        let value;
        try {
          value = await request(
            route`/rest/api/3/project/search?typeKey=software&status=live&orderBy=key&startAt=${start}&maxResults=100`,
          );
        } catch (error) {
          // Documented: 404 when no space matches the search.
          if (!page && error instanceof JiraHttpError && error.status === 404)
            return { projects: [], incomplete: false };
          throw error;
        }
        if (
          !Array.isArray(value?.values) ||
          value.startAt !== start ||
          typeof value.isLast !== 'boolean'
        )
          throw new UserError('Space inventory is incomplete. Reload before choosing spaces.');
        for (const item of value.values) {
          const id = numeric(item?.id);
          if (
            seen.has(id) ||
            typeof item.key !== 'string' ||
            typeof item.name !== 'string' ||
            !['classic', 'next-gen'].includes(item.style)
          )
            throw new UserError(
              'Space inventory changed or has an unsupported shape. Reload before choosing spaces.',
            );
          seen.add(id);
          projects.push({
            id,
            key: item.key,
            name: item.name,
            teamManaged: item.style === 'next-gen',
          });
        }
        if (projects.length > 200) return { projects: projects.slice(0, 200), incomplete: true };
        if (value.isLast) return { projects, incomplete: false };
        if (!value.values.length) throw new UserError('Space inventory did not advance.');
        start += value.values.length;
      }
      return { projects, incomplete: true };
    },
    get: () => readState<BatchRecord>(kvs, batchStorageKey),
    cas: async (revision, data) => {
      if (Buffer.byteLength(JSON.stringify(data), 'utf8') > 190_000)
        throw new UserError('Configuration contains too many spaces. Select a smaller group.');
      try {
        await kvs
          .transact()
          .set(
            batchStorageKey,
            { revision: revision + 1, data: JSON.parse(JSON.stringify(data)) },
            {
              entityName: storageEntity,
              conditions: new Filter<BatchRecord>().and(
                'revision',
                revision === 0 ? FilterConditions.notExists() : FilterConditions.equalTo(revision),
              ),
            },
          )
          .execute();
      } catch {
        throw new UserError(
          'Configuration progress changed or storage is unavailable. Check saved progress.',
        );
      }
    },
  };
}
export function registerResolvers(sdk: Sdk) {
  const resolver = new sdk.Resolver();
  resolver.define('settings-projects', (request) =>
    resolveSafely(
      async () => {
        const raw = request.context as unknown;
        if (
          !record(raw) ||
          typeof raw.accountId !== 'string' ||
          !raw.accountId ||
          !record(raw.extension)
        )
          throw new UserError('Open Configure Agent Prompts for Jira in Jira settings.');
        requireEmptyPayload(request.payload ?? {});
        const ports = createBatchPorts(sdk);
        await ports.admin();
        return { ...(await ports.projects()), licensed: licensed(sdk.appContext()) };
      },
      (e) => e instanceof UserError,
    ),
  );

  for (const action of [
    'catalog',
    'status',
    'options',
    'preview',
    'start',
    'advance',
    'stop',
  ] as const)
    resolver.define(`configuration-${action}`, (request) =>
      resolveSafely(
        async () => {
          const raw = request.context as unknown;
          if (
            !record(raw) ||
            typeof raw.accountId !== 'string' ||
            !raw.accountId ||
            !record(raw.extension)
          )
            throw new UserError('Open Configure Agent Prompts for Jira in Jira settings.');
          const payload = request.payload ?? {};
          const fields =
            action === 'options'
              ? ['projectId']
              : action === 'preview'
                ? ['projectId', 'name', 'type', 'unlink', 'reloadAfterSave', 'screenTypes']
                : action === 'start'
                  ? [
                      'name',
                      'type',
                      'entries',
                      'revision',
                      'allowShared',
                      'allowSharedScreens',
                      'unlink',
                      'reloadAfterSave',
                    ]
                  : action === 'advance'
                    ? ['id', 'revision', 'key']
                    : action === 'stop'
                      ? ['id', 'revision', 'key', 'acknowledged']
                      : [];
          if (!record(payload) || Object.keys(payload).some((key) => !fields.includes(key)))
            throw new UserError('Unexpected configuration request fields.');
          if (
            ['start', 'advance', 'stop'].includes(action) &&
            (!Number.isSafeInteger(payload.revision) || Number(payload.revision) < 0)
          )
            throw new UserError('Invalid configuration revision.');
          // Without a license, administrators can still read, remove setup and recover; a run
          // continues only when it removes setup.
          const app = sdk.appContext();
          if ((action === 'preview' || action === 'start') && payload.unlink !== true)
            requireLicense(app);
          if (
            action === 'advance' &&
            !licensed(app) &&
            (await createBatchPorts(sdk).get())?.data.input.unlink !== true
          )
            requireLicense(app);
          const batch = createConfigurationBatch(
            createPorts(sdk),
            createSettingsPorts(sdk),
            createBatchPorts(sdk),
          );
          if (action === 'options')
            return batch.options(raw.accountId, String(payload.projectId ?? ''));
          if (action === 'preview' || action === 'start') {
            if (
              (payload.name !== undefined && typeof payload.name !== 'string') ||
              (payload.type !== undefined && typeof payload.type !== 'string') ||
              (payload.allowShared !== undefined && typeof payload.allowShared !== 'boolean') ||
              (payload.allowSharedScreens !== undefined &&
                typeof payload.allowSharedScreens !== 'boolean') ||
              (payload.unlink !== undefined && typeof payload.unlink !== 'boolean')
            )
              throw new UserError('Invalid work type.');
            // Every configuration names its reload choice; removing setup names none.
            const reloadAfterSave =
              payload.unlink === true && payload.reloadAfterSave === undefined
                ? undefined
                : reloadInput(payload.reloadAfterSave);
            const input = {
              ...(typeof payload.name === 'string' ? { name: payload.name } : {}),
              ...(typeof payload.type === 'string' ? { type: payload.type } : {}),
              ...(payload.allowShared === true ? { allowShared: true } : {}),
              ...(payload.allowSharedScreens === true ? { allowSharedScreens: true } : {}),
              ...(payload.unlink === true ? { unlink: true } : {}),
              ...(reloadAfterSave ? { reloadAfterSave } : {}),
            };
            if (action === 'preview')
              return batch.preview(raw.accountId, String(payload.projectId ?? ''), {
                ...input,
                ...(payload.screenTypes !== undefined
                  ? { screenTypes: screenTypesInput(payload.screenTypes)! }
                  : {}),
              });
            if (
              !Array.isArray(payload.entries) ||
              payload.entries.some(
                (e) =>
                  !record(e) ||
                  typeof e.projectId !== 'string' ||
                  typeof e.fingerprint !== 'string' ||
                  (e.type !== undefined && typeof e.type !== 'string') ||
                  Object.keys(e).some(
                    (k) => !['projectId', 'fingerprint', 'screenTypes', 'type'].includes(k),
                  ),
              )
            )
              throw new UserError('Invalid reviewed spaces.');
            return batch.start(
              input,
              (payload.entries as Record<string, unknown>[]).map((e) => ({
                projectId: e.projectId as string,
                fingerprint: e.fingerprint as string,
                ...(e.screenTypes !== undefined
                  ? { screenTypes: screenTypesInput(e.screenTypes)! }
                  : {}),
                ...(typeof e.type === 'string' ? { type: e.type } : {}),
              })),
              Number(payload.revision),
            );
          }
          if (payload.key !== undefined && (typeof payload.key !== 'string' || !payload.key))
            throw new UserError('Invalid configuration request.');
          if (action === 'advance')
            return batch.advance(
              raw.accountId,
              payload.key,
              String(payload.id ?? ''),
              Number(payload.revision),
            );
          if (action === 'stop')
            return batch.stop(
              payload.key,
              String(payload.id ?? ''),
              Number(payload.revision),
              payload.acknowledged === true,
            );
          return batch[action]();
        },
        (e) => e instanceof UserError,
      ),
    );
  for (const name of ['setup', 'search', 'load', 'save', 'save-status', 'resolve-save'] as const) {
    resolver.define(name, (request) =>
      resolveSafely(
        async () => {
          const service = createService(createPorts(sdk));
          const c = context(request.context);
          const payload = request.payload ?? {};
          if (!record(payload)) throw new UserError('Invalid request.');
          const allowed =
            name === 'save'
              ? ['ids', 'revision', 'sync']
              : name === 'resolve-save'
                ? ['revision', 'fingerprint', 'acknowledged']
                : name === 'search'
                  ? ['query', 'cursor']
                  : [];
          if (Object.keys(payload).some((k) => !allowed.includes(k)))
            throw new UserError('Unexpected request fields.');
          // Recovery of an unresolved save stays available without a license.
          if (name !== 'save-status' && name !== 'resolve-save') requireLicense(sdk.appContext());
          if (name === 'save-status') return service.saveStatus(c);
          if (name === 'resolve-save')
            return service.resolveSave(
              c,
              payload as unknown as Parameters<typeof service.resolveSave>[1],
            );
          if (name === 'save')
            return service.save(c, payload as unknown as Parameters<typeof service.save>[1]);
          if (name === 'search') return service.search(c, payload);
          return service[name](c);
        },
        (e) => e instanceof UserError || e instanceof DescriptionError,
      ),
    );
  }
  // Settings resolvers serve the space details view. Type changes and setup removal go through
  // the reviewed multi-space configuration, which serializes configuration writes.
  const actions = ['health', 'recover', 'resolve', 'preferences'] as const;
  for (const action of actions)
    resolver.define(`settings-${action}`, (request) =>
      resolveSafely(
        async () => {
          const settings = createSettings(createPorts(sdk), createSettingsPorts(sdk));
          const payload = request.payload ?? {};
          if (!record(payload)) throw new UserError('Invalid request.');
          const fields = [
            'projectId',
            ...(action === 'resolve'
              ? ['revision', 'acknowledged']
              : action === 'preferences'
                ? ['revision', 'refreshAfterSave']
                : []),
          ];
          if (Object.keys(payload).some((key) => !fields.includes(key)))
            throw new UserError('Unexpected request fields.');
          if (
            (action === 'resolve' || action === 'preferences') &&
            (!Number.isSafeInteger(payload.revision) || Number(payload.revision) < 0)
          )
            throw new UserError('Invalid configuration revision.');
          if (action === 'resolve' && payload.acknowledged !== true)
            throw new UserError(
              'Inspect Jira and acknowledge the earlier operation before resolving it.',
            );
          if (action === 'preferences' && typeof payload.refreshAfterSave !== 'boolean')
            throw new UserError('Invalid display preference.');
          // Health checks and recovery stay available without a license.
          if (action === 'preferences') requireLicense(sdk.appContext());
          const raw = request.context as unknown;
          if (
            !record(raw) ||
            typeof raw.accountId !== 'string' ||
            !raw.accountId ||
            !record(raw.extension)
          )
            throw new UserError('Open Configure Agent Prompts for Jira in Jira settings.');
          const trustedProject = record(raw.extension.project)
            ? numeric(raw.extension.project.id)
            : undefined;
          // Administration may target a selected space from either app surface.
          // Every settings operation checks ADMINISTER on that explicit target.
          const c = {
            accountId: raw.accountId,
            projectId:
              (!payload.projectId ? trustedProject : undefined) ??
              (() => {
                const reference = payload.projectId;
                if (typeof reference !== 'string' || !/^[1-9]\d{0,19}$/.test(reference))
                  throw new UserError('Choose a Jira space.');
                return reference;
              })(),
          };
          if (action === 'resolve') return settings.resolve(c, Number(payload.revision));
          if (action === 'preferences')
            return settings.preferences(c, {
              revision: Number(payload.revision),
              refreshAfterSave: payload.refreshAfterSave as boolean,
            });
          return settings[action](c);
        },
        (e) => e instanceof UserError,
      ),
    );
  return resolver.getDefinitions();
}
export function registerRovo(sdk: Sdk) {
  return async (payload: unknown, raw: unknown) =>
    resolveSafely(
      async () => {
        const accountId = rovoAccountId(raw);
        // A payload that is not an object has no space key, so requireProjectKey refuses it.
        const input: Record<string, unknown> = record(payload) ? payload : {};
        const projectKey = requireProjectKey(input.projectKey);
        // Validate the whole request before any Jira call. The action reads one exact key, as
        // its manifest description says; a numeric ID is not accepted here.
        const promptKey =
          input.promptKey !== undefined && input.promptKey !== ''
            ? exactKey(input.promptKey, 'Provide one exact prompt key, such as TEAM-42.')
            : undefined;
        if (!promptKey && (typeof input.query !== 'string' || input.query.length > 200))
          throw new UserError('Provide a search query of at most 200 characters.');
        requireLicense(sdk.appContext());
        const service = createService(createPorts(sdk));
        // Resolve the explicit space through the actor-bound API, never from chat identity fields.
        let project: unknown;
        try {
          project = await requester(sdk)(sdk.route`/rest/api/3/project/${projectKey}`);
        } catch (error) {
          if (error instanceof JiraHttpError && error.status === 429) throw error;
          if (error instanceof JiraHttpError) throw new UserError('Space is unavailable.');
          throw error;
        }
        requireSoftwareSpace(project, projectKey);
        const c = { accountId, projectId: numeric(String((project as { id: unknown }).id)) };
        if (promptKey) return service.read(c, promptKey);
        const result = await service.search(c, { query: input.query as string }, 20);
        return { prompts: result.prompts, incomplete: result.incomplete };
      },
      (e) => e instanceof UserError || e instanceof DescriptionError,
    );
}
