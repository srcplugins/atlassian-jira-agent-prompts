import React, { useEffect, useState } from 'react';
import { view } from '@forge/bridge';
import { Field } from './field';

/**
 * Jira also shows the field on its Create form. Saving copies prompts into an existing work item's
 * description, so there the field only says when to add them, and leaves the value empty.
 */
export function FieldRoot() {
  const [renderContext, setRenderContext] = useState<string>();
  useEffect(() => {
    view.getContext().then(
      (context) => setRenderContext(String(context.extension?.renderContext ?? 'issue-view')),
      () => setRenderContext('issue-view'),
    );
  }, []);
  if (!renderContext) return null;
  if (renderContext === 'issue-create')
    return (
      <div className="prompt-field">
        <p>Add prompts after you create the work item.</p>
      </div>
    );
  return <Field />;
}
