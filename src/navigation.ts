/** Stable numeric IDs keep the search scoped after project/type renames. */
export function promptSearchUrl(projectId: string, typeId: string): string {
  if (![projectId, typeId].every((id) => /^[1-9]\d{0,19}$/.test(id)))
    throw new Error('Invalid prompt search configuration.');
  return `/issues/?jql=${encodeURIComponent(`project = ${projectId} AND issuetype = ${typeId} ORDER BY key ASC`)}`;
}
