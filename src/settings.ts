import {
  hash,
  limited,
  numeric,
  JiraRejected,
  JiraUnavailable,
  StorageUnavailable,
  UserError,
  type Context,
  type Ports,
} from './service';
import { JiraHttpError, requireSoftwareSpace } from './shared/jira.mjs';

/** A configuration step that provably changed nothing in Jira and left no claim in storage.
 * `retryable` means repeating the reviewed step can succeed (a brief outage); otherwise the
 * space needs a new review. */
export class NotApplied extends UserError {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.retryable = retryable;
  }
}
const uncertainSetup =
  'Configuration stopped with an uncertain or partial result. Check the space again, then choose Check outcome. No write was retried; do not create another type.';
const uncertainScreens =
  'Screen changes stopped with an uncertain or partial result. Check the reviewed screens in Jira, then review this space again. No write was retried; a field the app finds without its record is treated as added outside the app and is never removed by it.';
const uncertainScreensAfterType =
  'The work type was added to the space, but screen changes stopped with an uncertain or partial result. Choose Check outcome, then check the reviewed screens in Jira and review this space again. No write was retried.';
/** Jira or storage was briefly unavailable rather than refusing the request. An unclassified
 * error is a defect, not an outage: repeating the step would fail the same way. */
export function transient(error: unknown) {
  return (
    error instanceof JiraUnavailable ||
    error instanceof StorageUnavailable ||
    (error instanceof JiraHttpError && (error.status === 429 || error.status >= 500))
  );
}
function notApplied(error: unknown, retryable: boolean) {
  const reason =
    error instanceof UserError ? error.message : 'An unexpected error stopped this step.';
  return new NotApplied(
    /nothing was changed/i.test(reason) ? reason : `${reason} Nothing was changed.`,
    retryable,
  );
}
interface WorkType {
  id: string;
  name: string;
  subtask: boolean;
  hierarchyLevel?: number;
  scope?: unknown;
}
function eligible(type: WorkType) {
  return type.hierarchyLevel === 0 && !type.subtask && !type.scope;
}
/** A team-managed space's standard work types. All of its work types are its own: Jira can't add
 * global types to a team-managed space. */
function ownTypes(project: { issueTypes: Omit<WorkType, 'scope'>[] }) {
  return project.issueTypes
    .filter((t) => t.hierarchyLevel === 0 && !t.subtask)
    .map((t) => ({ id: t.id, name: t.name }))
    .sort((a, b) => byNumber(a.id, b.id));
}
/** At most this many of a team-managed space's work types are checked for the field. */
const layoutLimit = 50;
/** The scheme of a review that changes no work type scheme. */
const noScheme = (): Scheme => ({ id: '', name: '', projectIds: [], isDefault: false });
interface SettingsData {
  refreshAfterSave?: boolean;
  type?: string;
  previousTypes?: string[];
  /** Work types whose edit and view screens should show the Agent Prompts field. */
  screenTypes?: string[];
  /** Screens on which this space is listed in the app's ownership record. */
  screens?: string[];
  pending?: { name?: string; type?: string; scheme: string; started: number };
}
export interface SettingsRecord {
  revision: number;
  data: SettingsData;
}
interface Scheme {
  id: string;
  name: string;
  projectIds: string[];
  isDefault: boolean;
  projects?: { id: string; key?: string; name?: string }[];
  /** False when Jira listed only part of a shared scheme's spaces: usable, never changed. */
  complete?: false;
}
type ScreenOp = 'create' | 'edit' | 'view';
export interface ScreenInfo {
  id: string;
  name: string;
  tabs: { id: string; fields: string[] }[];
}
interface Space {
  id: string;
  key?: string;
  name?: string;
}
/** The app added `field` to the screen; `projects` are the spaces relying on that. The field is
 * removed only when the last of them no longer needs it. */
interface ScreenRecordData {
  field: string;
  projects: string[];
}
export interface ScreenRecord {
  revision: number;
  data: ScreenRecordData;
}
/** One reviewed screen change. Jira writes are add, remove (the Agent Prompts field) and require
 * (Summary or Description on the prompt type's create screen); join, leave and drop only update
 * the app's ownership records. */
export interface ScreenChange {
  action: 'add' | 'join' | 'leave' | 'remove' | 'drop' | 'require';
  screen: { id: string; name: string };
  tab?: string;
  field: string;
  types: string[];
  /** Ownership record revision the change was reviewed against; 0 when there is none. */
  record: number;
  impact?: { spaces: number; shared: boolean; digest: string };
}
type Write = Omit<ScreenChange, 'screen' | 'record' | 'impact'>;
export const screenWrite = (c: ScreenChange) => ['add', 'remove', 'require'].includes(c.action);
const byNumber = (a: string, b: string) => a.length - b.length || a.localeCompare(b);
export function sortScreenChanges(changes: ScreenChange[]) {
  return [...changes].sort(
    (a, b) =>
      byNumber(a.screen.id, b.screen.id) ||
      a.field.localeCompare(b.field) ||
      a.action.localeCompare(b.action),
  );
}
export interface SettingsPorts {
  get(project: string): Promise<SettingsRecord | undefined>;
  /** With `screen`, the ownership record is written (or deleted when `data` is null) in the same
   * storage transaction, conditioned on its revision. */
  cas(
    project: string,
    revision: number,
    data: SettingsData,
    screen?: { id: string; revision: number; data: ScreenRecordData | null },
  ): Promise<void>;
  types(): Promise<WorkType[]>;
  scheme(project: string): Promise<Scheme>;
  create(name: string): Promise<string>;
  attach(scheme: string, type: string): Promise<void>;
  createFields(project: string, type: string): Promise<string[]>;
  /** The screen used for each requested work type and operation; no type means the default. */
  screenUses(project: string, uses: { type?: string; op: ScreenOp }[]): Promise<string[]>;
  /** Screens in order, undefined for a screen Jira no longer has. Tabs list `field` where it is;
   * every field only for the screens in `full`. A screen without `field` lists all its tabs. */
  screens(ids: string[], field: string, full?: string[]): Promise<(ScreenInfo | undefined)[]>;
  /** The spaces using a screen; incomplete when there are too many, or the reads ran out of time. */
  screenImpact(
    screen: string,
  ): Promise<{ projects: Space[]; complete: boolean; timedOut?: boolean }>;
  addScreenField(screen: string, tab: string, field: string): Promise<void>;
  removeScreenField(screen: string, tab: string, field: string): Promise<void>;
  screenRecord(screen: string): Promise<ScreenRecord | undefined>;
  /** Whether a step of the stored configuration run is changing this space right now. */
  configuring(project: string): Promise<boolean>;
  /** Milliseconds this request can still spend before it must have finished its writes. */
  timeLeft(): number;
}
/** The Configure choice for each space's reload preference: keep it, or set it on or off. */
export type ReloadChoice = 'keep' | 'on' | 'off';
export function reloadInput(value: unknown): ReloadChoice {
  if (value !== 'keep' && value !== 'on' && value !== 'off')
    throw new UserError('Invalid display preference.');
  return value;
}
export interface SettingsInput {
  unlink?: boolean;
  /** Absent, like `keep`, leaves the space's saved preference unchanged. */
  reloadAfterSave?: ReloadChoice;
  allowShared?: boolean;
  allowSharedScreens?: boolean;
  type?: string;
  name?: string;
  screenTypes?: string[];
}
/** A requested work type selection for screens: up to 50 distinct IDs, sorted. */
export function screenTypesInput(value: unknown) {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length > 50 ||
    new Set(value).size !== value.length ||
    value.some((id) => typeof id !== 'string')
  )
    throw new UserError('Choose up to 50 distinct work types for screens.');
  return value.map(numeric).sort(byNumber);
}
function screenRecordData(value: ScreenRecord | undefined) {
  if (value === undefined) return undefined;
  const data = value?.data as Partial<ScreenRecordData> | undefined;
  if (
    !Number.isSafeInteger(value?.revision) ||
    value.revision < 1 ||
    typeof data?.field !== 'string' ||
    !Array.isArray(data.projects) ||
    data.projects.some((id) => typeof id !== 'string')
  )
    throw new UserError('A screen ownership record is unreadable. Check the screen in Jira.');
  return data as ScreenRecordData;
}
export function createSettings(p: Ports, s: SettingsPorts) {
  async function admin(c: Context) {
    await p.allowed(numeric(c.projectId), 'ADMINISTER');
    const project = await p.project(c.projectId);
    const teamManaged = requireSoftwareSpace(project, c.projectId) === 'team-managed';
    return { ...project, teamManaged };
  }
  /** The previous prompt types after replacing `old` with `type`, at most twenty. */
  function previousTypesAfter(data: SettingsData, type: string | undefined) {
    const old = data.type;
    const changing = !!old && old !== type;
    const previousTypes = Array.from(
      new Set([...(data.previousTypes ?? []), ...(changing ? [old!] : [])]),
    ).filter((id) => id !== type);
    // Only a change from a current type can pass twenty: removing setup keeps at most twenty.
    if (previousTypes.length > 20)
      throw new UserError(
        'This space already has twenty previous prompt types, the most the app keeps. Keep the current type.',
      );
    return previousTypes;
  }
  async function inspect(c: Context, project: Awaited<ReturnType<typeof admin>>) {
    const [record, types, scheme] = await Promise.all([
      s.get(c.projectId),
      s.types(),
      s.scheme(c.projectId),
    ]);
    const state = record ?? { revision: 0, data: {} };
    return { project, state, types, scheme };
  }
  /** Removing setup's checks against the reviewed revision, before its one storage write. */
  async function removalTarget(c: Context, revision: number) {
    await admin(c);
    const current = (await s.get(c.projectId)) ?? { revision: 0, data: {} };
    if (current.revision !== revision)
      throw new UserError('Configuration changed. Check the space again.');
    if (current.data.pending)
      throw new UserError(
        'Resolve the unfinished configuration before removing this space’s setup.',
      );
    return current;
  }
  /** The screen plan of a space whose screens the app never changes. */
  const noScreens = (): Awaited<ReturnType<typeof screenPlan>> => ({
    screens: { changes: [], present: [] },
    labels: {},
  });
  /** Screen changes for one space: the Agent Prompts field on the edit and view screens of the
   * selected work types, removal from screens this space no longer needs, and (when `prompt` is
   * given) Summary and Description on the prompt type's create screen. */
  async function screenPlan(
    projectId: string,
    data: SettingsData,
    selected: string[],
    prompt?: { type?: string },
  ) {
    const owned = data.screens ?? [];
    const changes: ScreenChange[] = [];
    const present: { id: string; name: string }[] = [];
    const labels: Record<string, Space[]> = {};
    if (!selected.length && !owned.length && !prompt)
      return { screens: { changes, present }, labels };
    const field = await p.field();
    const uses = selected.flatMap((type) =>
      (['edit', 'view'] as const).map((op) => ({ type, op })),
    );
    const ids = await s.screenUses(projectId, [
      ...uses,
      ...(prompt ? [{ ...(prompt.type ? { type: prompt.type } : {}), op: 'create' as const }] : []),
    ]);
    const needed = new Map<string, string[]>();
    uses.forEach((u, i) => {
      const id = ids[i]!;
      needed.set(id, [...new Set([...(needed.get(id) ?? []), u.type])]);
    });
    const promptScreen = prompt ? ids[uses.length] : undefined;
    const all = [...new Set([...needed.keys(), ...owned, ...(promptScreen ? [promptScreen] : [])])]
      .map(numeric)
      .sort(byNumber);
    if (all.length > 50)
      throw new UserError('Too many screens to review at once. Select fewer work types.');
    const [details, records] = await Promise.all([
      s.screens(all, field, promptScreen ? [promptScreen] : []),
      Promise.all(all.map((id) => s.screenRecord(id))),
    ]);
    // Jira writes wait for who uses each screen, which is read once every change is known.
    const writes: { screen: { id: string; name: string }; revision: number; change: Write }[] = [];
    for (const [i, id] of all.entries()) {
      const info = details[i];
      const stored = records[i];
      const recordData = screenRecordData(stored);
      const revision = stored?.revision ?? 0;
      const ours = recordData?.field === field ? recordData : undefined;
      const listed = !!ours?.projects.includes(projectId);
      const tab = info?.tabs.find((t) => t.fields.includes(field));
      const types = needed.get(id) ?? [];
      const screen = { id, name: info?.name ?? `Screen ${id}` };
      if ((needed.has(id) || id === promptScreen) && !info)
        throw new UserError('A screen used by this space could not be read. Check Jira settings.');
      const write = (change: Write) => writes.push({ screen, revision, change });
      if (needed.has(id)) {
        if (!tab) {
          if (!info!.tabs.length)
            throw new UserError(`The screen ${screen.name} has no tabs. Add one in Jira settings.`);
          write({ action: 'add', tab: info!.tabs[0]!.id, field, types });
        } else if (ours) {
          if (!listed || !owned.includes(id))
            changes.push({ action: 'join', screen, field, types, record: revision });
        } else {
          // Added outside the app: never recorded, so never removed by the app.
          present.push(screen);
          if (owned.includes(id))
            changes.push({ action: 'drop', screen, field, types, record: revision });
        }
      } else if (owned.includes(id)) {
        if (!listed || !info || !tab)
          changes.push({ action: 'drop', screen, field, types, record: revision });
        else if (ours!.projects.some((p) => p !== projectId))
          changes.push({ action: 'leave', screen, field, types, record: revision });
        else write({ action: 'remove', tab: tab.id, field, types });
      }
      if (id === promptScreen)
        for (const required of ['summary', 'description'])
          if (!info!.tabs.some((t) => t.fields.includes(required))) {
            if (!info!.tabs.length)
              throw new UserError(
                `The screen ${screen.name} has no tabs. Add one in Jira settings.`,
              );
            write({ action: 'require', tab: info!.tabs[0]!.id, field: required, types: [] });
          }
    }
    const written = [...new Set(writes.map((w) => w.screen.id))];
    const impacts = new Map(
      (await limited(written, (id) => s.screenImpact(id))).map((impact, i) => [
        written[i]!,
        impact,
      ]),
    );
    for (const { screen, revision, change } of writes) {
      const impact = impacts.get(screen.id)!;
      if (impact.timedOut)
        throw new JiraUnavailable(
          `The spaces using the screen ${screen.name} could not all be read in time. Review this space again.`,
        );
      if (!impact.complete)
        throw new UserError(
          `The screen ${screen.name} is used by more spaces than can be reviewed. Change it in Jira settings instead.`,
        );
      labels[screen.id] = impact.projects;
      changes.push({
        ...change,
        screen,
        record: change.action === 'require' ? 0 : revision,
        impact: {
          spaces: impact.projects.length,
          shared: impact.projects.some((p) => p.id !== projectId),
          digest: hash(impact.projects.map((p) => p.id)),
        },
      });
    }
    return {
      screens: {
        changes: sortScreenChanges(changes),
        present,
        ...(promptScreen ? { promptScreen } : {}),
      },
      labels,
    };
  }
  /** A team-managed space's checks: its prompt type, the field, and which of its work types have
   * the field on their layout. Jira reports a layout through create metadata, one read per work
   * type; nothing here blocks setup. */
  async function ownHealth(
    c: Context,
    project: Awaited<ReturnType<typeof admin>>,
    state: SettingsRecord,
  ) {
    const types = ownTypes(project);
    const selected = types.find((t) => t.id === state.data.type);
    const checks: { label: string; ok: boolean; detail: string }[] = [
      {
        label: 'Work type',
        ok: !!selected,
        detail: !state.data.type
          ? 'Choose the space’s prompt work type.'
          : selected
            ? `${selected.name} is this space’s prompt work type. Renames are supported.`
            : 'The configured type was deleted or is no longer a standard work type of this space. Choose a replacement.',
      },
    ];
    let field: string | undefined;
    try {
      field = await p.field();
      checks.push({
        label: 'Agent Prompts field',
        ok: true,
        detail: 'Agent Prompts field exists.',
      });
    } catch (e) {
      checks.push({
        label: 'Agent Prompts field',
        ok: false,
        detail: e instanceof UserError ? e.message : 'Field could not be checked.',
      });
    }
    // The prompt type is always among the checked types.
    const checked = [...(selected ? [selected] : []), ...types.filter((t) => t !== selected)].slice(
      0,
      layoutLimit,
    );
    // Layout reads start only while more than ten seconds of the request are left, like the
    // screen reads of a review, so a slow or failing Jira leaves the remaining layouts unknown
    // instead of timing out the whole check.
    const late = new Set<string>();
    const read = await limited(checked, (t) => {
      if (s.timeLeft() <= 10_000) {
        late.add(t.id);
        return Promise.resolve(undefined);
      }
      return s.createFields(c.projectId, t.id).then(
        (ids) => ids,
        () => undefined,
      );
    });
    const fieldsOf = (id: string) => read[checked.findIndex((t) => t.id === id)];
    if (selected) {
      const ids = fieldsOf(selected.id);
      const ok = !!ids && ['summary', 'description'].every((f) => ids.includes(f));
      checks.push({
        label: 'Prompt creation',
        ok,
        detail: late.has(selected.id)
          ? 'The prompt type’s fields weren’t checked in time. Check this space again.'
          : !ids
            ? 'The prompt type’s fields could not be checked. Check the Create work items permission in this space.'
            : ok
              ? 'The summary and description fields are on the prompt type’s layout.'
              : 'Add the summary and description fields to the prompt type’s layout in Space settings → Work types.',
      });
    }
    const layouts = checked
      .filter((t) => t !== selected)
      .sort((a, b) => byNumber(a.id, b.id))
      .map((t) => {
        const ids = fieldsOf(t.id);
        return {
          id: t.id,
          name: t.name,
          ...(ids && field ? { present: ids.includes(field) } : {}),
        };
      });
    if (field) {
      const names = (keep: (l: (typeof layouts)[number]) => boolean) =>
        layouts
          .filter(keep)
          .map((l) => l.name)
          .join(', ');
      const on = names((l) => l.present === true);
      const off = names((l) => l.present === false);
      const failed = names((l) => l.present === undefined && !late.has(l.id));
      const unchecked = names((l) => late.has(l.id));
      const unknown = failed || unchecked;
      checks.push({
        label: 'Agent Prompts on layouts',
        ok: !!on,
        detail: [
          // A layout that could not be read is never counted as missing the field.
          on
            ? `The field is on the layout of ${on}.`
            : unknown && !off
              ? 'No work type’s layout could be checked.'
              : unknown
                ? 'The field wasn’t found on a checked work type’s layout.'
                : 'The field is on no work type’s layout. Add it to the layouts of the work types that use prompts in Space settings → Work types.',
          off ? `It isn’t on ${off}.` : '',
          failed
            ? `${failed} could not be checked. Check the Create work items permission in this space.`
            : '',
          unchecked ? `Not checked in time: ${unchecked}. Check this space again.` : '',
          types.length > layoutLimit
            ? `Only the first ${layoutLimit} work types were checked.`
            : '',
        ]
          .filter(Boolean)
          .join(' '),
      });
    }
    return { project, state, types, selected, layouts, canConfigure: true, checks };
  }
  async function plan(c: Context, input: SettingsInput) {
    if (input.reloadAfterSave !== undefined) reloadInput(input.reloadAfterSave);
    if (input.unlink) {
      if (
        input.type !== undefined ||
        input.name !== undefined ||
        input.reloadAfterSave !== undefined ||
        input.screenTypes !== undefined
      )
        throw new UserError('Removing setup cannot include a type or preference change.');
      const project = await admin(c);
      const state = (await s.get(c.projectId)) ?? { revision: 0, data: {} };
      if (state.data.pending)
        throw new UserError(
          'Resolve the unfinished configuration before removing this space’s setup.',
        );
      // A team-managed space has no screens for the app to change, so nothing more is read.
      const { screens, labels } = project.teamManaged
        ? noScreens()
        : await screenPlan(c.projectId, state.data, []);
      const result = {
        unlink: true,
        ...(project.teamManaged ? { teamManaged: true } : {}),
        revision: state.revision,
        old: state.data.type,
        type: undefined,
        name: undefined,
        attach: false,
        scheme: noScheme(),
        project: { id: project.id, key: project.key },
        previousTypes: state.data.previousTypes ?? [],
        typeName: 'Remove setup',
        screenTypes: [] as string[],
        availableTypes: [] as { id: string; name: string }[],
        screens,
      };
      return { ...result, fingerprint: hash([c.accountId, result]), screenProjects: labels };
    }
    const project = await admin(c);
    // A team-managed space's administrator creates the prompt type and places the field by hand,
    // so its setup only records which of the space's own work types holds prompts.
    if (project.teamManaged) {
      if (input.name !== undefined)
        throw new UserError(
          'Create the prompt work type in Space settings → Work types, then choose it here.',
        );
      if (input.screenTypes !== undefined)
        throw new UserError('Team-managed spaces have no screens for the app to change.');
      if (typeof input.type !== 'string')
        throw new UserError('Choose this space’s prompt work type.');
      const state = (await s.get(c.projectId)) ?? { revision: 0, data: {} };
      if (state.data.pending)
        throw new UserError(
          'An earlier configuration needs an outcome check before another change.',
        );
      const type = numeric(input.type);
      const chosen = ownTypes(project).find((t) => t.id === type);
      if (!chosen) throw new UserError('Choose one of this space’s standard work types.');
      const previousTypes = previousTypesAfter(state.data, type);
      const { screens, labels } = noScreens();
      const result = {
        teamManaged: true,
        ...(input.reloadAfterSave !== undefined ? { reloadAfterSave: input.reloadAfterSave } : {}),
        revision: state.revision,
        old: state.data.type,
        type,
        name: undefined,
        attach: false,
        scheme: noScheme(),
        project: { id: project.id, key: project.key },
        previousTypes,
        typeName: chosen.name,
        screenTypes: [] as string[],
        availableTypes: [] as { id: string; name: string }[],
        screens,
      };
      return { ...result, fingerprint: hash([c.accountId, result]), screenProjects: labels };
    }
    const value = await inspect(c, project);
    if (value.state.data.pending)
      throw new UserError('An earlier configuration needs an outcome check before another change.');
    const creating = typeof input.name === 'string';
    const name = input.name?.trim();
    if (
      creating &&
      (!name || name.length > 60 || Array.from(name).some((char) => char.charCodeAt(0) < 32))
    )
      throw new UserError('Choose a work type name of 1–60 characters.');
    if (creating && input.type) throw new UserError('Create a type or choose an existing one.');
    if (creating && value.types.some((t) => t.name.toLowerCase() === name!.toLowerCase()))
      throw new UserError(
        'That work type name already exists. Choose another name or select an existing standard global work type.',
      );
    const type = creating ? undefined : numeric(input.type);
    if (type && !value.types.some((t) => t.id === type && eligible(t)))
      throw new UserError('Choose an available standard global work type.');
    const attach = creating || !value.project.issueTypes.some((t) => t.id === type);
    if (attach && value.scheme.isDefault)
      throw new UserError(
        'This space uses Jira’s default work type scheme. Add the type in Jira settings, then select it here.',
      );
    if (attach && value.scheme.complete === false)
      throw new UserError(
        'This space’s work type scheme is shared with more spaces than Jira lists at once, so their impact can’t be reviewed. Add the type to the scheme in Jira settings, then select it here.',
      );
    if (
      !value.scheme.isDefault &&
      value.scheme.complete !== false &&
      !value.scheme.projectIds.includes(c.projectId)
    )
      throw new UserError(
        'The space’s scheme association could not be confirmed. Review Jira settings.',
      );
    const old = value.state.data.type;
    const previousTypes = previousTypesAfter(value.state.data, type);
    // The prompt type itself is excluded: its own screens get Summary and Description instead.
    const availableTypes = value.project.issueTypes
      .filter((t) => t.id !== type)
      .map((t) => ({ id: t.id, name: t.name }))
      .sort((a, b) => byNumber(a.id, b.id));
    const requested = screenTypesInput(input.screenTypes);
    if (requested?.some((id) => !availableTypes.some((t) => t.id === id)))
      throw new UserError('Choose work types used in this space for the Agent Prompts field.');
    const screenTypes =
      requested ??
      (value.state.data.screenTypes ?? []).filter((id) => availableTypes.some((t) => t.id === id));
    // A screen the app can't change blocks the space, but its work types are still offered so a
    // different selection can avoid that screen.
    let planned: Awaited<ReturnType<typeof screenPlan>>;
    let blocked: string | undefined;
    try {
      planned = await screenPlan(c.projectId, value.state.data, screenTypes, {
        ...(type ? { type } : {}),
      });
    } catch (error) {
      if (!(error instanceof UserError) || transient(error)) throw error;
      planned = { screens: { changes: [], present: [] }, labels: {} };
      blocked = error.message;
    }
    const { screens, labels } = planned;
    const result = {
      ...(blocked ? { blocked } : {}),
      ...(input.reloadAfterSave !== undefined ? { reloadAfterSave: input.reloadAfterSave } : {}),
      revision: value.state.revision,
      old,
      type,
      name,
      attach,
      scheme: value.scheme,
      project: { id: value.project.id, key: value.project.key },
      previousTypes,
      typeName: name ?? value.types.find((t) => t.id === type)!.name,
      screenTypes,
      availableTypes,
      screens,
    };
    // Space names for the screen impact review are display-only, so outside the fingerprint.
    return { ...result, fingerprint: hash([c.accountId, result]), screenProjects: labels };
  }
  return {
    async preferences(c: Context, input: { revision: number; refreshAfterSave: boolean }) {
      await admin(c);
      if (
        !Number.isSafeInteger(input.revision) ||
        input.revision < 0 ||
        typeof input.refreshAfterSave !== 'boolean'
      )
        throw new UserError('Invalid display preference.');
      const current = (await s.get(c.projectId)) ?? { revision: 0, data: {} };
      if (current.revision !== input.revision || current.data.pending)
        throw new UserError('Configuration changed or is unfinished. Reload Space configuration.');
      // A running step that changes only screens takes no claim, but it commits each screen change
      // with the setup revision it read, so a save now would leave that change unrecorded.
      if (await s.configuring(c.projectId))
        throw new UserError(
          'A configuration is changing this space right now. Save the preference after it finishes.',
        );
      await s.cas(c.projectId, current.revision, {
        ...current.data,
        refreshAfterSave: input.refreshAfterSave,
      });
      return { saved: true };
    },
    async health(c: Context) {
      // Diagnostic failures must not hide a durable pending operation or its
      // manual recovery controls. Mutation planning still uses strict inspect.
      const project = await admin(c);
      const state = (await s.get(c.projectId)) ?? { revision: 0, data: {} };
      if (project.teamManaged) return ownHealth(c, project, state);
      const [typesResult, schemeResult] = await Promise.allSettled([
        s.types(),
        s.scheme(c.projectId),
      ]);
      const types = typesResult.status === 'fulfilled' ? typesResult.value : undefined;
      const scheme = schemeResult.status === 'fulfilled' ? schemeResult.value : undefined;
      const selected = types?.find((t) => t.id === state.data.type);
      const checks: { label: string; ok: boolean; detail: string }[] = [];
      const available =
        !!selected &&
        eligible(selected) &&
        project.issueTypes.some((t) => t.id === selected.id && !t.subtask);
      checks.push({
        label: 'Work type',
        ok: available,
        detail: !types
          ? 'Work types could not be checked. Inspect Jira settings before resolving any pending operation, then check the space again.'
          : !state.data.type
            ? 'Choose or create a work type.'
            : !selected || !eligible(selected)
              ? 'The configured type is deleted, unavailable or no longer a standard global work type. Choose a replacement.'
              : available
                ? `${selected.name} is available in this space. Renames are supported.`
                : `${selected.name} exists but is missing from this space. Use Reconfigure space to review a repair.`,
      });
      if (!scheme)
        checks.push({
          label: 'Work type scheme',
          ok: false,
          detail:
            'The space’s work type scheme could not be checked completely. Inspect its association in Jira settings; new configuration changes remain blocked until this check succeeds.',
        });
      try {
        await p.field();
        checks.push({
          label: 'Agent Prompts field',
          ok: true,
          detail: 'Agent Prompts field exists.',
        });
      } catch (e) {
        checks.push({
          label: 'Agent Prompts field',
          ok: false,
          detail: e instanceof UserError ? e.message : 'Field could not be checked.',
        });
      }
      if (available) {
        try {
          const fields = await s.createFields(c.projectId, selected!.id);
          const ok = ['summary', 'description'].every((f) => fields.includes(f));
          checks.push({
            label: 'Prompt creation',
            ok,
            detail: ok
              ? 'The summary and description fields are available when creating this type.'
              : 'Add the summary and description fields to the type’s create screen: use Reconfigure space to review adding them, or change the screen in Jira settings.',
          });
        } catch {
          checks.push({
            label: 'Prompt creation',
            ok: false,
            detail:
              'Could not verify create fields. Check Create work items permission and the type’s screen configuration.',
          });
        }
      }
      const screenTypes = state.data.screenTypes ?? [];
      const recorded = state.data.screens ?? [];
      if (screenTypes.length || recorded.length) {
        try {
          const field = await p.field();
          const ids = screenTypes.length
            ? [
                ...new Set(
                  await s.screenUses(
                    c.projectId,
                    screenTypes.flatMap((type) =>
                      (['edit', 'view'] as const).map((op) => ({ type, op })),
                    ),
                  ),
                ),
              ]
            : [];
          // Screens the app still lists this space on although the selection no longer uses them,
          // for example after an interrupted removal.
          const extra = recorded.filter((id) => !ids.includes(id));
          const all = [...ids, ...extra];
          const info = await s.screens(all, field);
          const name = (id: string) => info[all.indexOf(id)]?.name ?? `screen ${id}`;
          const missing = ids.filter(
            (id, i) => !info[i]?.tabs.some((t) => t.fields.includes(field)),
          );
          const problems = [
            ...(missing.length
              ? [`The field is missing from ${missing.map(name).join(', ')}.`]
              : []),
            ...(extra.length
              ? [
                  `The app still records adding the field to ${extra.map(name).join(', ')}, which the selected work types don’t use.`,
                ]
              : []),
          ];
          checks.push({
            label: 'Agent Prompts on screens',
            ok: !problems.length,
            detail: !problems.length
              ? 'The field is on the edit and view screens of the selected work types.'
              : `${problems.join(' ')} Use Reconfigure space to review the screen changes.`,
          });
        } catch {
          checks.push({
            label: 'Agent Prompts on screens',
            ok: false,
            detail:
              'The screens of the selected work types could not be checked. Inspect them in Jira settings.',
          });
        }
      }
      return {
        project,
        state,
        types: (types ?? []).filter(eligible),
        selected,
        scheme,
        canConfigure: !!types && !!scheme,
        checks,
      };
    },
    preview: plan,
    /** The Work types step's data for a space: the work types it offers for the Agent Prompts
     * field and its saved selection among them. The dialog leaves out the prompt type it knows;
     * the review checks the selection against the prompt type again. A team-managed space gets
     * its own standard work types and its saved prompt type, which may no longer be one of them,
     * so its setup can still be removed. */
    async options(c: Context): Promise<
      | { teamManaged: true; promptTypes: { id: string; name: string }[]; type?: string }
      | {
          teamManaged?: undefined;
          availableTypes: { id: string; name: string }[];
          screenTypes: string[];
        }
    > {
      const project = await admin(c);
      const record = await s.get(c.projectId);
      // A team-managed space offers its own work types for its prompt type instead.
      if (project.teamManaged) {
        const type = record?.data.type;
        return { teamManaged: true, promptTypes: ownTypes(project), ...(type ? { type } : {}) };
      }
      const availableTypes = project.issueTypes
        .map((t) => ({ id: t.id, name: t.name }))
        .sort((a, b) => byNumber(a.id, b.id));
      return {
        availableTypes,
        screenTypes: (record?.data.screenTypes ?? []).filter((id) =>
          availableTypes.some((t) => t.id === id),
        ),
      };
    },
    /**
     * `planned` is this invocation's own review of the same input (a configuration step reviews
     * the space, then applies); without it the space is reviewed here.
     */
    async apply(
      c: Context,
      input: SettingsInput & { fingerprint: string },
      planned?: Awaited<ReturnType<typeof plan>>,
    ) {
      // Before the claim nothing is written, so every failure is NotApplied. A retry is only
      // meaningful when Jira or storage was briefly unavailable.
      let preview: Awaited<ReturnType<typeof plan>>;
      let field = '';
      try {
        preview = planned ?? (await plan(c, input));
        if ('blocked' in preview && preview.blocked) throw new UserError(preview.blocked);
        if (preview.fingerprint !== input.fingerprint)
          throw new UserError(
            'Configuration or its visible impact changed. Review the change again.',
          );
        if (preview.screens.changes.some((ch) => ch.impact?.shared) && !input.allowSharedScreens)
          throw new UserError('Confirm the shared screens’ affected spaces before applying.');
        if (preview.screens.changes.some((ch) => ch.action !== 'require')) field = await p.field();
      } catch (error) {
        throw notApplied(error, transient(error));
      }
      // A request stopped by the platform mid-way leaves an uncertain result, so this step makes
      // only the screen changes that fit in the time left (about a second each, after up to two
      // type writes); the rest are reported back and applied by the next step after a new check.
      const budget = Math.floor((s.timeLeft() - 3_000) / 1_000) - 2;
      if (budget < Math.min(1, preview.screens.changes.length))
        throw notApplied(
          new UserError('Too little time was left in this request to apply the changes.'),
          true,
        );
      let changes: ScreenChange[] = [];
      const outcome = {
        saved: true as const,
        /** Reviewed changes left for a later step, by screen and field. */
        remaining: [] as { screen: string; field: string }[],
      };
      /** Makes the first `count` reviewed screen changes in this step and leaves the rest. */
      const fit = (count: number) => {
        changes = preview.screens.changes.slice(0, count);
        outcome.remaining = preview.screens.changes
          .slice(count)
          .map((ch) => ({ screen: ch.screen.id, field: ch.field }));
      };
      fit(budget);
      // Counted before each Jira write: only a failure before the first write, or a documented
      // rejection of that first write, proves Jira is unchanged.
      let sent = 0;
      // Any storage write may have committed despite an error.
      let stored = false;
      let revision = 0;
      let data: SettingsData = {};
      /** Applies the reviewed screen changes in order. Each Jira write is followed by one storage
       * transaction that records it, so a recorded screen is always one the app changed. */
      async function screenPhase() {
        const touched: ScreenChange[] = [];
        for (const ch of changes) {
          const existing = await s.screenRecord(ch.screen.id);
          if (ch.action !== 'require' && (existing?.revision ?? 0) !== ch.record)
            throw new UserError(
              'A screen’s Agent Prompts setup changed during configuration. Review this space again.',
            );
          const current = screenRecordData(existing);
          const ours = current?.field === field ? current : undefined;
          const others = (ours?.projects ?? []).filter((id) => id !== c.projectId);
          const id = ch.screen.id;
          let next: ScreenRecordData | null | undefined;
          let joined: boolean;
          if (ch.action === 'require') {
            sent++;
            await s.addScreenField(id, ch.tab!, ch.field);
            touched.push(ch);
            continue;
          } else if (ch.action === 'add') {
            sent++;
            await s.addScreenField(id, ch.tab!, field);
            touched.push(ch);
            next = { field, projects: [...others, c.projectId].sort(byNumber) };
            joined = true;
          } else if (ch.action === 'join') {
            if (!ours) throw new UserError('A screen ownership record changed. Review again.');
            next = { field, projects: [...others, c.projectId].sort(byNumber) };
            joined = true;
          } else if (ch.action === 'remove') {
            if (others.length) throw new UserError('A screen ownership record changed.');
            sent++;
            await s.removeScreenField(id, ch.tab!, field);
            touched.push(ch);
            next = null;
            joined = false;
          } else {
            // leave or drop: only this space's entry in the record goes.
            next =
              ours && ours.projects.includes(c.projectId)
                ? others.length
                  ? { field, projects: others }
                  : null
                : undefined;
            joined = false;
          }
          const { screens: listed = [], ...rest } = data;
          const screens = listed.filter((x) => x !== id);
          if (joined) screens.push(id);
          data = screens.length ? { ...rest, screens: screens.sort(byNumber) } : rest;
          // The selection is saved with the first recorded change, so after a partial result the
          // health check and the next review compare Jira with what was chosen.
          if (!input.unlink) {
            delete data.screenTypes;
            if (preview.screenTypes.length) data.screenTypes = preview.screenTypes;
          }
          stored = true;
          await s.cas(
            c.projectId,
            revision,
            data,
            next === undefined ? undefined : { id, revision: ch.record, data: next },
          );
          revision++;
        }
        // Confirm Jira shows each written change before reporting success.
        const ids = [...new Set(touched.map((ch) => ch.screen.id))];
        const full = [
          ...new Set(touched.filter((ch) => ch.field !== field).map((ch) => ch.screen.id)),
        ];
        const after = ids.length ? await s.screens(ids, field, full) : [];
        for (const ch of touched) {
          const info = after[ids.indexOf(ch.screen.id)];
          const shown = !!info?.tabs.some((t) => t.fields.includes(ch.field));
          if (shown !== (ch.action !== 'remove'))
            throw new UserError('Jira has not confirmed a screen change.');
        }
      }
      /** A failure without a claim: unchanged only before any write or when Jira rejected the
       * first one. A storage failure before any Jira write keeps its own message. */
      function screenFailure(error: unknown) {
        if (!stored && (sent === 0 || (sent === 1 && error instanceof JiraRejected)))
          return notApplied(error, sent === 0 && transient(error));
        return sent === 0 && error instanceof UserError ? error : new UserError(uncertainScreens);
      }
      // Removing setup clears the space's setup after removing the screens it alone relied on.
      if (input.unlink) {
        let current: SettingsRecord;
        try {
          current = await removalTarget(c, preview.revision);
        } catch (error) {
          throw notApplied(error, transient(error));
        }
        revision = current.revision;
        data = current.data;
        try {
          await screenPhase();
          // Setup stays until its last screen change, so a later step can finish the removal.
          if (outcome.remaining.length) return outcome;
          // Keep previous type IDs so prompts already selected on work items stay removable if
          // the space is set up again, at most twenty like setup: the oldest gives way to the
          // type just removed. Never modify Jira work items or shared schemes.
          const previousTypes = Array.from(
            new Set([
              ...(current.data.previousTypes ?? []),
              ...(current.data.type ? [current.data.type] : []),
            ]),
          ).slice(-20);
          stored = true;
          await s.cas(c.projectId, revision, {
            previousTypes,
            ...(data.screens?.length ? { screens: data.screens } : {}),
          });
        } catch (error) {
          throw screenFailure(error);
        }
        return outcome;
      }
      let current: SettingsRecord;
      try {
        if (preview.attach && preview.scheme.projectIds.length > 1 && input.allowShared !== true)
          throw new UserError('Confirm the shared scheme’s affected spaces before applying.');
        current = (await s.get(c.projectId)) ?? { revision: 0, data: {} };
        if (current.revision !== preview.revision)
          throw new UserError(
            'Another administrator changed configuration. Check the space again.',
          );
      } catch (error) {
        throw notApplied(error, transient(error));
      }
      revision = current.revision;
      data = current.data;
      const configured = (type: string): SettingsData => {
        const rest: SettingsData = { ...data };
        delete rest.screenTypes;
        return {
          ...rest,
          // Keep never writes the preference, so a space without one stays off.
          ...(input.reloadAfterSave === 'on' || input.reloadAfterSave === 'off'
            ? { refreshAfterSave: input.reloadAfterSave === 'on' }
            : {}),
          type,
          previousTypes: preview.previousTypes,
          ...(preview.screenTypes.length ? { screenTypes: preview.screenTypes } : {}),
        };
      };
      if (!preview.attach) {
        try {
          await screenPhase();
          stored = true;
          await s.cas(c.projectId, revision, configured(preview.type!));
        } catch (error) {
          throw screenFailure(error);
        }
        return outcome;
      }
      const pending: NonNullable<SettingsData['pending']> = {
        ...(preview.name ? { name: preview.name } : {}),
        ...(preview.type ? { type: preview.type } : {}),
        scheme: preview.scheme.id,
        started: Date.now(),
      };
      // A lost response here may have committed the claim, so failure stays uncertain.
      data = { ...current.data, pending };
      await s.cas(c.projectId, revision++, data);
      const claimed = revision;
      let screensStarted = false;
      // Jira may not list a type it has just associated yet, so the space is read again, never
      // the association. The port already repeats a read that fails in transit.
      async function confirmAttached(type: string) {
        for (let attempt = 1; ; attempt++) {
          const project = await p.project(c.projectId);
          if (project.issueTypes.some((t) => t.id === type)) return;
          if (attempt === 3) throw new UserError('Jira has not confirmed the type association.');
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
      async function verifyScheme() {
        const fresh = await s.scheme(c.projectId);
        if (hash(fresh) !== hash(preview.scheme))
          throw new UserError(
            'The space scheme changed during configuration, before any further Jira write. Review this space again.',
          );
      }
      try {
        // A claim serializes this app, not concurrent changes in Jira settings.
        // Check before the first global side effect as well as before attachment.
        if (!pending.type) {
          await verifyScheme();
          sent++;
          pending.type = await s.create(preview.name!);
          data = { ...current.data, pending };
          await s.cas(c.projectId, revision++, data);
        }
        // Recheck scheme ownership after creation before modifying it.
        await verifyScheme();
        sent++;
        await s.attach(pending.scheme, pending.type);
        await confirmAttached(pending.type);
        await verifyScheme();
        // The type writes and their confirming reads can take longer than the time set aside for
        // them, so the screen changes are fitted again to the time left; the rest wait for the
        // next step.
        const left = Math.floor((s.timeLeft() - 3_000) / 1_000);
        if (left < changes.length) fit(Math.max(0, left));
        // The claim stays through the screen changes, so a partial result keeps its outcome check.
        screensStarted = true;
        await screenPhase();
        const final = configured(pending.type);
        delete final.pending;
        await s.cas(c.projectId, revision, final);
      } catch (error) {
        const unchanged =
          revision === claimed && (sent === 0 || (sent === 1 && error instanceof JiraRejected));
        if (unchanged) {
          try {
            await s.cas(c.projectId, claimed, { ...current.data });
          } catch {
            throw new UserError(uncertainSetup);
          }
          // The revision moved, so the reviewed fingerprint no longer applies: review again.
          throw notApplied(error, false);
        }
        throw new UserError(screensStarted ? uncertainScreensAfterType : uncertainSetup);
      }
      return outcome;
    },
    async recover(c: Context) {
      const project = await admin(c);
      const pending = (await s.get(c.projectId))?.data.pending;
      if (!pending) return { message: 'No unresolved configuration operation.' };
      if (!pending.type)
        return {
          message:
            'Creation outcome is unknown. Inspect Jira work types for the requested name, then acknowledge manual resolution below. Do not create a duplicate.',
        };
      let types: WorkType[];
      try {
        types = await s.types();
      } catch {
        return {
          message:
            'The recorded type could not be checked. Inspect Jira’s type list and the space association before acknowledging resolution. The outcome remains unknown; do not repeat its writes.',
        };
      }
      const type = types.find((t) => t.id === pending.type);
      if (type && !eligible(type))
        return {
          message:
            'The recorded type exists but is no longer a standard global work type. Inspect Jira settings before acknowledging resolution, then choose a replacement. Do not repeat the earlier writes.',
        };
      const attached = project.issueTypes.some((t) => t.id === pending.type);
      return {
        message: type
          ? attached
            ? 'The type exists and is attached. Acknowledge resolution, then select this type and review the change.'
            : 'The type exists but is not attached. Acknowledge resolution, then select it to review repairing the association.'
          : 'The recorded type is unavailable. Inspect Jira settings before acknowledging resolution.',
      };
    },
    async resolve(c: Context, revision: number) {
      await admin(c);
      const current = await s.get(c.projectId);
      if (!current?.data.pending || current.revision !== revision)
        throw new UserError('Configuration changed. Check the space again.');
      // Do not unlock an active request. Forge resolver execution is bounded well below this delay.
      if (Date.now() - current.data.pending.started < 120_000)
        throw new UserError(
          'Wait two minutes for the earlier request to finish, then check its outcome.',
        );
      const data = { ...current.data };
      delete data.pending;
      await s.cas(c.projectId, revision, data);
      return { saved: true };
    },
  };
}
