import React from 'react';
import { HealthProjects } from './health-ui';
export function Configuration({
  projectId,
  onBusy,
}: {
  projectId?: string;
  onBusy?: (busy: boolean) => void;
}) {
  return <HealthProjects {...(projectId ? { projectId } : {})} {...(onBusy ? { onBusy } : {})} />;
}
