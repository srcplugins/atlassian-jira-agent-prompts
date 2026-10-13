import { createSettings, type SettingsPorts, type SettingsRecord } from './settings';
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
  requireCompanyManagedSoftware,
  requireEmptyPayload,
  requireProjectKey,
  rovoAccountId,
} from './shared/jira.mjs';
import {
  createService,
  JiraRejected,
  JiraUnavailable,
  StorageUnavailable,
  numeric,
  UserError,
  type Context,
  type Issue,
  type Ports,
  type Prompt,
  type Stored,
} from './service';
import { DescriptionError } from './description';
interface Sdk {
  Resolver: typeof import('@forge/resolver').default;
  api: typeof import('@forge/api').default;
  route: typeof import('@forge/api').route;
  kvs: typeof import('@forge/kvs').kvs;
  Filter: typeof import('@forge/kvs').Filter;
  FilterConditions: typeof import('@forge/kvs').FilterConditions;
  fieldType(): string;
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
    return await kvs.entity<T>('native-prompt-state').get(key);
  } catch {
    throw new StorageUnavailable('App storage is unavailable. Try again shortly.');
  }
}
function requester({ api }: Sdk) {
  async function request(path: ReturnType<Sdk['route']>, method = 'GET', body?: unknown) {
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
          throw new UserError('Add the Agent Prompts field to this work item’s screen.');
        return matches[0].id;
      })();
      return fieldPromise;
    },
    search: async (project, type, input) => {
      if (input) {
        const query = input.query?.trim() ?? '';
        // Treat input as text, never as executable JQL/Lucene syntax. Exact work item keys
        // use Jira's key lookup; words use ANDed, escaped prefix terms in Summary.
        const key = /^[A-Z][A-Z0-9_]*-[1-9]\d*$/i.test(query);
        const tokens = (query.match(/[\p{L}\p{N}_]+/gu) ?? []).map((word) => word.toLowerCase());
        if (query && !key && !tokens.length) return { prompts: [], incomplete: false };
        // Jira does not index stop words and treats operator words specially: alone they match
        // everything, but inside a multi-word query their clause matches nothing. Drop them; a
        // query of only such words lists the newest prompts, as Jira's own search does.
        const words = tokens.filter((word) => !reservedWords.has(word));
        // One text clause per word, ANDed in JQL. The prefix matches a word as typed; the bare
        // word matches Jira's stemmed index, where "tests*" misses a stored "test".
        const clause = key
          ? ` AND key = ${JSON.stringify(query.toUpperCase())}`
          : words.length
            ? ` AND ${words
                .map(
                  (word) =>
                    `(summary ~ ${JSON.stringify(`${word}*`)} OR summary ~ ${JSON.stringify(word)})`,
                )
                .join(' AND ')}`
            : '';
        let value;
        try {
          value = await request(route`/rest/api/3/search/jql`, 'POST', {
            jql: `project = ${numeric(project)} AND issuetype = ${numeric(type)}${clause} ORDER BY created DESC, key DESC`,
            fields: ['summary', 'project', 'issuetype'],
            maxResults: input.limit,
            ...(input.cursor ? { nextPageToken: input.cursor } : {}),
          });
        } catch (error) {
          // Jira answers 400 for an exact key that does not exist or is not visible, and for
          // text it cannot parse. Either way nothing matches; it is not an access failure.
          // A follow-up page (expired or invalid cursor) is a failed page, never the end of results.
          if (query && !input.cursor && error instanceof JiraHttpError && error.status === 400)
            return { prompts: [], incomplete: false };
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
      }
      const prompts: Prompt[] = [];
      const seen = new Set<string>();
      let token: string | undefined;
      for (let page = 0; page < 3; page++) {
        const value = await request(route`/rest/api/3/search/jql`, 'POST', {
          jql: `project = ${numeric(project)} AND issuetype = ${numeric(type)} ORDER BY key ASC`,
          fields: ['summary'],
          maxResults: 100,
          ...(token ? { nextPageToken: token } : {}),
        });
        if (!Array.isArray(value?.issues) || typeof value.isLast !== 'boolean')
          throw new UserError('Incomplete Jira search data.');
        for (const issue of value.issues) {
          if (!issue || typeof issue.key !== 'string' || typeof issue.fields?.summary !== 'string')
            throw new UserError('Incomplete prompt metadata.');
          numeric(issue.id);
          if (prompts.some((p) => p.id === issue.id))
            throw new UserError('Jira returned repeated search results. Check the space again.');
          if (prompts.length === 120) return { prompts, incomplete: true };
          prompts.push({ id: issue.id, key: issue.key, name: issue.fields.summary });
        }
        if (value.isLast) return { prompts, incomplete: false };
        if (
          typeof value.nextPageToken !== 'string' ||
          !value.nextPageToken ||
          seen.has(value.nextPageToken)
        )
          throw new UserError('Invalid Jira search cursor.');
        token = value.nextPageToken;
        seen.add(token!);
      }
      return { prompts, incomplete: true };
    },
    issue: async (id, field) => {
      if (!/^(?:[1-9]\d{0,19}|[A-Z][A-Z0-9_]{1,30}-[1-9]\d*)$/.test(id))
        throw new UserError('Invalid work item key.');
      const fields = `project,issuetype,summary,description,updated${field ? `,${field}` : ''}`;
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
              entityName: 'native-prompt-state',
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
  const request = requester(sdk);
  return {
    get: (project) => readState<SettingsRecord>(kvs, `config-${project}`),
    cas: async (project, revision, data) => {
      try {
        await kvs
          .transact()
          .set(
            `config-${project}`,
            { revision: revision + 1, data: JSON.parse(JSON.stringify(data)) },
            {
              entityName: 'native-prompt-state',
              conditions: new Filter<SettingsRecord>().and(
                'revision',
                revision === 0 ? FilterConditions.notExists() : FilterConditions.equalTo(revision),
              ),
            },
          )
          .execute();
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
    impact: async (project, _type, field) => {
      if (!/^customfield_[1-9]\d*$/.test(field)) throw new UserError('Invalid prompt field.');
      const value = await request(route`/rest/api/3/search/jql`, 'POST', {
        jql: `project = ${numeric(project)} AND cf[${field.slice(12)}] IS NOT EMPTY ORDER BY key ASC`,
        fields: ['summary'],
        maxResults: 100,
      });
      if (
        !Array.isArray(value?.issues) ||
        typeof value.isLast !== 'boolean' ||
        value.issues.some((i: { key?: unknown }) => typeof i.key !== 'string')
      )
        throw new UserError('Jira returned incomplete data about work items using these prompts.');
      return { keys: value.issues.map((i: { key: string }) => i.key), incomplete: !value.isLast };
    },
    createFields: async (project, type) => {
      const value = await request(
        route`/rest/api/3/issue/createmeta/${project}/issuetypes/${type}?maxResults=200`,
      );
      if (!Array.isArray(value?.fields) || value.total > value.fields.length)
        throw new UserError('Create fields are incomplete.');
      return value.fields.map((f: { fieldId: string }) => f.fieldId);
    },
  };
}
// Storage key of the unfinished multi-space configuration. Renaming it would orphan a saved run.
const batchStorageKey = 'configuration-batch';
export function createBatchPorts(sdk: Sdk): BatchPorts {
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
      // Team-managed spaces are fetched and discarded, so stay well inside the resolver's
      // 25-second limit and report a partial inventory instead of timing out.
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
          if (item.style === 'classic') projects.push({ id, key: item.key, name: item.name });
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
              entityName: 'native-prompt-state',
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
        return ports.projects();
      },
      (e) => e instanceof UserError,
    ),
  );

  for (const action of [
    'catalog',
    'status',
    'cancel-interrupted',
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
            action === 'preview'
              ? ['projectId', 'name', 'type', 'unlink', 'refreshAfterSave']
              : action === 'start'
                ? [
                    'name',
                    'type',
                    'entries',
                    'revision',
                    'allowShared',
                    'unlink',
                    'refreshAfterSave',
                  ]
                : action === 'advance'
                  ? ['id', 'revision']
                  : action === 'stop'
                    ? ['id', 'revision', 'acknowledged']
                    : action === 'cancel-interrupted'
                      ? ['id']
                      : [];
          if (!record(payload) || Object.keys(payload).some((key) => !fields.includes(key)))
            throw new UserError('Unexpected configuration request fields.');
          if (
            ['start', 'advance', 'stop'].includes(action) &&
            (!Number.isSafeInteger(payload.revision) || Number(payload.revision) < 0)
          )
            throw new UserError('Invalid configuration revision.');
          const batch = createConfigurationBatch(
            createPorts(sdk),
            createSettingsPorts(sdk),
            createBatchPorts(sdk),
          );
          if (action === 'preview' || action === 'start') {
            if (
              (payload.name !== undefined && typeof payload.name !== 'string') ||
              (payload.type !== undefined && typeof payload.type !== 'string') ||
              (payload.allowShared !== undefined && typeof payload.allowShared !== 'boolean') ||
              (payload.unlink !== undefined && typeof payload.unlink !== 'boolean') ||
              (payload.refreshAfterSave !== undefined &&
                typeof payload.refreshAfterSave !== 'boolean')
            )
              throw new UserError('Invalid work type.');
            const input = {
              ...(typeof payload.name === 'string' ? { name: payload.name } : {}),
              ...(typeof payload.type === 'string' ? { type: payload.type } : {}),
              ...(payload.allowShared === true ? { allowShared: true } : {}),
              ...(payload.unlink === true ? { unlink: true } : {}),
              ...(typeof payload.refreshAfterSave === 'boolean'
                ? { refreshAfterSave: payload.refreshAfterSave }
                : {}),
            };
            if (action === 'preview')
              return batch.preview(raw.accountId, String(payload.projectId ?? ''), input);
            if (
              !Array.isArray(payload.entries) ||
              payload.entries.some(
                (e) =>
                  !record(e) ||
                  typeof e.projectId !== 'string' ||
                  typeof e.fingerprint !== 'string' ||
                  Object.keys(e).some((k) => !['projectId', 'fingerprint'].includes(k)),
              )
            )
              throw new UserError('Invalid reviewed spaces.');
            return batch.start(
              raw.accountId,
              input,
              payload.entries as { projectId: string; fingerprint: string }[],
              Number(payload.revision),
            );
          }
          if (action === 'cancel-interrupted') {
            if (payload.id !== undefined && (typeof payload.id !== 'string' || !payload.id))
              throw new UserError('Invalid configuration request.');
            return batch.cancelInterrupted(raw.accountId, payload.id as string | undefined);
          }
          if (action === 'advance')
            return batch.advance(raw.accountId, String(payload.id ?? ''), Number(payload.revision));
          if (action === 'stop')
            return batch.stop(
              raw.accountId,
              String(payload.id ?? ''),
              Number(payload.revision),
              payload.acknowledged === true,
            );
          return batch[action]();
        },
        (e) => e instanceof UserError,
      ),
    );
  for (const name of [
    'setup',
    'search',
    'load',
    'save',
    'save-status',
    'resolve-save',
    'accept-save',
  ] as const) {
    resolver.define(name, (request) =>
      resolveSafely(
        async () => {
          const service = createService(createPorts(sdk));
          const c = context(request.context);
          const payload = request.payload ?? {};
          if (!record(payload)) throw new UserError('Invalid request.');
          const allowed =
            name === 'save'
              ? ['ids', 'revision', 'fingerprint']
              : name === 'resolve-save' || name === 'accept-save'
                ? ['revision', 'fingerprint', 'acknowledged']
                : name === 'search'
                  ? ['query', 'cursor']
                  : [];
          if (Object.keys(payload).some((k) => !allowed.includes(k)))
            throw new UserError('Unexpected request fields.');
          if (name === 'save-status') return service.saveStatus(c);
          if (name === 'resolve-save')
            return service.resolveSave(
              c,
              payload as unknown as Parameters<typeof service.resolveSave>[1],
            );
          if (name === 'accept-save')
            return service.acceptSave(
              c,
              payload as unknown as Parameters<typeof service.acceptSave>[1],
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
              ? ['revision']
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
          if (action === 'preferences' && typeof payload.refreshAfterSave !== 'boolean')
            throw new UserError('Invalid display preference.');
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
              (await (async () => {
                const reference = payload.projectId;
                if (
                  typeof reference !== 'string' ||
                  !/^(?:[1-9]\d{0,19}|[A-Z][A-Z0-9_]{1,30})$/.test(reference)
                )
                  throw new UserError('Enter a Jira space key or numeric ID.');
                if (/^[1-9]\d*$/.test(reference)) return reference;
                // Resolve a key only for a Jira administrator, so the lookup reveals nothing
                // a non-administrator could not already learn from Jira.
                await createBatchPorts(sdk).admin();
                const value = await requester(sdk)(sdk.route`/rest/api/3/project/${reference}`);
                return numeric(value?.id);
              })()),
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
        const checked = requireCompanyManagedSoftware(project, projectKey) as { id: unknown };
        const c = { accountId, projectId: numeric(String(checked.id)) };
        if (promptKey) return service.read(c, promptKey);
        const result = await service.search(c, { query: input.query as string }, 20);
        return { prompts: result.prompts, incomplete: result.incomplete };
      },
      (e) => e instanceof UserError || e instanceof DescriptionError,
    );
}
