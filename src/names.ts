// Names stored against this app's registration. The manifest declares the field key and the
// storage entity; saved field values, stored records and managed description sections refer to
// all three, so they are permanent once the app is registered.

/** The `jira:customField` module key in manifest.yml. */
export const fieldKey = 'native-prompts-field';

/** The Forge storage entity in manifest.yml (`app.storage.entities`). */
export const storageEntity = 'native-prompt-state';

/** Prefix of a managed description section's local ID; the work item ID follows it. */
const sectionIdPrefix = 'npl-';

export const sectionLocalId = (issueId: string) => `${sectionIdPrefix}${issueId}`;

/** The field's type in Jira's field list, which Jira derives from the app, environment and key. */
export const fieldType = (appId: string, environmentId: string) =>
  `ari:cloud:ecosystem::extension/${appId}/${environmentId}/static/${fieldKey}`;
