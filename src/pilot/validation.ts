import type { Assignment } from '../types.js';

/** Optional operator scope limits, not required fields or production parser rules. */
export interface PilotLimits { maxAssignments?: number; allowedMethods?: string[] }
export function acceptsPilotDrafts(drafts: Assignment[], limits: PilotLimits = {}) {
  if (!drafts.length) return false;
  if (limits.maxAssignments !== undefined && drafts.length > limits.maxAssignments) return false;
  // Unknown destinations always enter correction; never assume a default destination.
  if (limits.allowedMethods && drafts.some(draft => draft.submissionMethod && !limits.allowedMethods!.includes(draft.submissionMethod))) return false;
  return true;
}
