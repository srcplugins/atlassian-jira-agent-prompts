import React, { useEffect, useState } from 'react';
import ForgeReconciler, { Text } from '@forge/react';
import { call } from './client';
import { HealthProjects } from './health-ui';
function ProjectSettings() {
  const [id, setId] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    call<{ project: { id: string } }>('setup').then(
      (v) => setId(v.project.id),
      (e) => setError(e.message),
    );
  }, []);
  return id ? <HealthProjects projectId={id} /> : <Text>{error || 'Loading space…'}</Text>;
}
ForgeReconciler.render(<ProjectSettings />);
