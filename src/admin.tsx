import React from 'react';
import ForgeReconciler, { Text } from '@forge/react';
import { Configuration } from './configuration';
import { build } from './build-info';
ForgeReconciler.render(
  <>
    <Configuration />
    <Text>Build {build}</Text>
  </>,
);
