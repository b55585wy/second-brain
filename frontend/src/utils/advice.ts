import type { AdviceState } from '../types';

export function advicePending(advice: AdviceState | null | undefined): boolean {
  return advice?.status === 'queued' || advice?.status === 'running';
}

export function preferReadyAdvice(current: AdviceState | null | undefined, incoming: AdviceState | null | undefined): AdviceState | null | undefined {
  if (!current || !incoming || current.attemptId !== incoming.attemptId) return incoming;
  if (current.status === 'ready' && current.feedback && (incoming.status !== 'ready' || !incoming.feedback)) return current;
  return incoming;
}
