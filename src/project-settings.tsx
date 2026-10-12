import React, { useEffect, useState } from 'react';
import ForgeReconciler, { Text } from '@forge/react';
import { call } from './client';
import { Configuration } from './configuration';
function ProjectSettings() {
  const [id, setId] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    call<{ project: { id: string } }>('setup').then(
      (v) => setId(v.project.id),
      (e) => setError(e.message),
    );
  }, []);
  return id ? <Configuration projectId={id} /> : <Text>{error || 'Loading project…'}</Text>;
}
ForgeReconciler.render(<ProjectSettings />);
