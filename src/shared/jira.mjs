// Shared srcplugins file, synchronized across repositories.
// @ts-check
// Jira request and input helpers shared by plugins (synchronized to src/shared/jira.mjs).

/** A failure whose message is safe to show the user. Anything else becomes a generic message. */
export class UserError extends Error {}

/** A non-2xx Jira response. The status is kept so callers can classify write outcomes. */
export class JiraHttpError extends UserError {
  /** @param {number} status @param {string} [message] */
  constructor(status, message) {
    super(message ?? `Jira request failed (HTTP ${status}). Check your access or try again later.`);
    this.status = status;
  }
}

// Statuses Jira documents as rejecting a write before applying it, per endpoint. 429 is included:
// Jira refuses rate-limited requests before processing them. Anything else (5xx, transport
// failures, unreadable success bodies) leaves the outcome uncertain and must be reconciled by
// reading, never retried.
const definitiveRejections = {
  'issue-edit': [400, 401, 403, 404, 409, 422, 429],
  'issuetype-create': [400, 401, 403, 409, 429],
  'issuetypescheme-add': [400, 401, 403, 404, 429],
  'screen-field-add': [400, 401, 403, 404, 429],
  'screen-field-remove': [400, 401, 403, 404, 429],
};

/**
 * Whether a write's HTTP status proves Jira did not apply it.
 * @param {keyof typeof definitiveRejections} operation
 * @param {number} status
 */
export function isDefinitiveRejection(operation, status) {
  const statuses = definitiveRejections[operation];
  if (!statuses) throw Error(`Unknown Jira write operation: ${operation}`);
  return statuses.includes(status);
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const projectKeyPattern = /^[A-Z][A-Z0-9_]{1,49}$/;

/**
 * The invoking user's account ID from a Rovo action context. Never read identity from the payload.
 * @param {unknown} context
 */
export function rovoAccountId(context) {
  const accountId = isRecord(context) && isRecord(context.principal) && context.principal.accountId;
  if (typeof accountId !== 'string' || !accountId.trim())
    throw new UserError('Authenticated user context is required.');
  return accountId;
}

/** @param {unknown} value @returns {string} */
export function requireProjectKey(value) {
  if (typeof value !== 'string' || !projectKeyPattern.test(value))
    throw new UserError('Provide one explicit uppercase space key.');
  return value;
}

/**
 * The space ID from a space-page resolver context.
 * @param {unknown} context
 */
export function projectContext(context) {
  const extension = isRecord(context) && isRecord(context.extension) ? context.extension : {};
  const id = isRecord(extension.project) ? String(extension.project.id ?? '') : '';
  if (
    !isRecord(context) ||
    typeof context.accountId !== 'string' ||
    !context.accountId.trim() ||
    !/^[1-9]\d*$/.test(id)
  )
    throw new UserError('Open this app in a Jira space.');
  return { accountId: context.accountId, projectId: id };
}

/**
 * Rejects payload fields an operation does not accept.
 * @param {unknown} [payload]
 */
export function requireEmptyPayload(payload = {}) {
  if (!isRecord(payload) || Object.keys(payload).length)
    throw new UserError('This operation does not accept custom inputs.');
}

/**
 * Confirms the response is the requested company-managed Jira Software space. Use it only in a
 * plugin that doesn't support team-managed Software spaces.
 * @param {unknown} project
 * @param {string} idOrKey The numeric ID or key that was requested.
 */
export function requireCompanyManagedSoftware(project, idOrKey) {
  if (!isRecord(project) || (String(project.id) !== idOrKey && project.key !== idOrKey))
    throw new UserError('Space context does not match.');
  if (project.projectTypeKey !== 'software' || project.style !== 'classic')
    throw new UserError('Company-managed Jira software spaces only.');
  return project;
}

/**
 * Confirms the response is the requested Jira Software space, company-managed or team-managed, and
 * says which. Use it in a plugin that supports both.
 * @param {unknown} project
 * @param {string} idOrKey The numeric ID or key that was requested.
 * @returns {'company-managed' | 'team-managed'}
 */
export function requireSoftwareSpace(project, idOrKey) {
  if (!isRecord(project) || (String(project.id) !== idOrKey && project.key !== idOrKey))
    throw new UserError('Space context does not match.');
  if (
    project.projectTypeKey !== 'software' ||
    (project.style !== 'classic' && project.style !== 'next-gen')
  )
    throw new UserError('Jira software spaces only.');
  return project.style === 'classic' ? 'company-managed' : 'team-managed';
}

/**
 * Runs a read up to three times, pausing between tries, while `transient` says its failure was
 * Jira being briefly unavailable (a transport failure or a 5xx); Jira can briefly fail a read,
 * often of a space created moments earlier. Any other failure stands at once. Never pass a write:
 * repeating one could apply it twice. With a `deadline` (epoch milliseconds), a try starts only
 * if its pause ends before it, so a read near a time budget's end fails instead of outrunning it.
 * @template T
 * @param {() => Promise<T>} read
 * @param {(error: unknown) => boolean} transient
 * @param {number} [deadline]
 * @returns {Promise<T>}
 */
export async function readWithRetries(read, transient, deadline = Infinity) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      if (attempt === 3 || !transient(error) || Date.now() + 500 * attempt >= deadline) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
  }
}

class JiraConnectionError extends UserError {}

/**
 * Reads JSON as the invoking user: use it only for reads (GET, or a read-only POST such as
 * `search/jql`). Transport failures, non-2xx responses (as JiraHttpError) and unreadable bodies
 * become UserErrors; a transport failure or 5xx is tried again up to twice (`readWithRetries`).
 * @param {Pick<import('@forge/api').FetchAPI, 'asUser'>} api
 */
export function jiraReader(api) {
  /**
   * @param {import('@forge/api').Route} path
   * @param {{ method?: string, headers?: Record<string, string>, body?: string }} options
   */
  const readOnce = async (path, options) => {
    let response;
    try {
      response = await api.asUser().requestJira(path, {
        method: 'GET',
        ...options,
        headers: { Accept: 'application/json', ...options.headers },
      });
    } catch {
      throw new JiraConnectionError('Jira connection failed. Try again.');
    }
    if (!response.ok) throw new JiraHttpError(response.status);
    try {
      return await response.json();
    } catch {
      throw new UserError('Jira returned unreadable data.');
    }
  };
  /**
   * @param {import('@forge/api').Route} path
   * @param {{ method?: string, headers?: Record<string, string>, body?: string }} [options]
   */
  return (path, options = {}) =>
    readWithRetries(
      () => readOnce(path, options),
      (error) =>
        error instanceof JiraConnectionError ||
        (error instanceof JiraHttpError && error.status >= 500),
    );
}
