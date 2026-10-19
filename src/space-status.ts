import type { Health } from './settings-ui';

export type Status =
  'Not checked' | 'Check failed' | 'Needs attention' | 'Not configured' | 'Healthy';
/** A checked space's status, as both the space list and its details show it. */
export function configurationStatus(health: Health): Status {
  return health.state.data.pending
    ? 'Needs attention'
    : !health.state.data.type
      ? 'Not configured'
      : health.checks.every((check) => check.ok)
        ? 'Healthy'
        : 'Needs attention';
}
/** The lozenge colour of each status, and of a check under way. */
export const appearance = {
  Healthy: 'success',
  'Needs attention': 'moved',
  'Check failed': 'removed',
  'Not configured': 'default',
  'Not checked': 'default',
  Checking: 'default',
} as const;
