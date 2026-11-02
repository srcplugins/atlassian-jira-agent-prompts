import React, { useEffect, useState } from 'react';
import { view } from '@forge/bridge';
import { Field } from './field';

/**
 * A display condition keeps the field off Jira's Create form. Should Jira still render it there,
 * the field only says to add prompts once the work item exists, and leaves the value empty: saving
 * copies prompts into an existing work item's description.
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
