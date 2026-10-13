import React from 'react';
import ForgeReconciler, { Text } from '@forge/react';
import { HealthProjects } from './health-ui';
import { build } from './build-info';
ForgeReconciler.render(
  <>
    <HealthProjects />
    <Text>Build {build}</Text>
  </>,
);
