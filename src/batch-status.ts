import type { BatchData } from './configuration-batch';

/** Whether a configuration batch has ended: completed, or stopped with its reason recorded. */
export const finished = (status: BatchData['status']) =>
  status === 'complete' || status === 'stopped';
