export const FIELDS = {
  profile: ['goals', 'careerDirection', 'skills', 'dailyBudgetMinutes', 'timeZone', 'revision', 'createdAt', 'updatedAt'],
  projects: ['id', 'title', 'goal', 'status', 'revision', 'createdAt', 'updatedAt'],
  checkpoints: ['id', 'projectId', 'progress', 'nextAction', 'openQuestion', 'createdAt'],
  knowledge: ['id', 'projectId', 'question', 'answer', 'sourceRefs', 'status', 'origin', 'siyuanBlockId', 'validation', 'lastDecision', 'sync', 'revision', 'createdAt', 'updatedAt'],
  practices: ['id', 'projectId', 'kind', 'goal', 'skill', 'prompt', 'estimatedMinutes', 'rubric', 'sourceRefs', 'provenance', 'status', 'revision', 'createdAt', 'updatedAt'],
  attempts: ['id', 'practiceId', 'output', 'assistanceLevel', 'evidenceRefs', 'evidenceSnapshots', 'submittedAt', 'feedback'],
  feedback: ['id', 'attemptId', 'mode', 'basis', 'summary', 'observations', 'nextActions', 'limitations', 'provenance', 'createdAt'],
  adviceSelections: ['id', 'feedbackId', 'attemptId', 'state', 'outputId', 'selectedAt', 'revision', 'createdAt', 'updatedAt'],
  adviceDiscussions: ['id', 'feedbackId', 'attemptId', 'currentVersion', 'lastTurnId', 'revision', 'createdAt', 'updatedAt'],
  adviceDiscussionTurns: ['id', 'feedbackId', 'attemptId', 'baseVersion', 'operationId', 'retryOfTurnId', 'message', 'status', 'reply', 'resultVersion', 'lastError', 'revision', 'createdAt', 'updatedAt'],
  adviceDiscussionVersions: ['id', 'feedbackId', 'attemptId', 'version', 'candidate', 'reply', 'turnId', 'outputId', 'decision', 'selectedAt', 'revision', 'createdAt', 'updatedAt'],
  outputs: ['id', 'projectId', 'practiceId', 'title', 'content', 'goal', 'status', 'sourceRefs', 'evidenceRefs', 'revision', 'createdAt', 'updatedAt'],
  plans: ['id', 'revision', 'date', 'timeZone', 'profileRevision', 'budgetMinutes', 'scheduledMinutes', 'unallocatedMinutes', 'reviewDueCount', 'status', 'items', 'notices', 'generationJobId', 'createdAt', 'updatedAt'],
  reviewSessions: ['id', 'projectId', 'deckId', 'limit', 'reviewedCount', 'status', 'pendingJobId', 'lastResponseId', 'createdAt', 'updatedAt'],
  reviewResponses: ['id', 'sessionId', 'presentationId', 'cardId', 'knowledgeId', 'rating', 'elapsedMs', 'operationId', 'status', 'committedAt', 'riffEvidence'],
  profileRevisions: ['id', 'profileRevision', 'values', 'changedAt', 'actor'],
  focusArtifacts: ['id', 'date', 'timeZone', 'profileRevision', 'scopeRevision', 'modelConfigKey', 'highlights', 'practiceId', 'sourceDigests', 'provenance', 'generatedAt', 'revision', 'createdAt', 'updatedAt'],
};

export const SOURCE_FIELDS = ['sourceId', 'kind', 'externalId', 'title', 'url', 'threadId', 'messageId', 'documentId', 'blockId', 'excerpt', 'contentDigest', 'role', 'occurredAt', 'capturedAt', 'redacted'];
export const select = (record, fields) => Object.fromEntries(fields.map(key => [key, record[key] ?? null]));
export const dto = (entity, record) => select(record, FIELDS[entity]);
