import type { IBackgroundJobStatus } from '@/types/liveness';

/**
 * Whether a registered job still holds its tab's work: attested alive, or a
 * remote job whose host has not answered (not known to have exited).
 */
export const jobHoldsWork = (job: Pick<IBackgroundJobStatus, 'alive'> & { state?: IBackgroundJobStatus['state'] }): boolean =>
  job.alive || job.state === 'unknown';
