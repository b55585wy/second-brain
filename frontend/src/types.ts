export type ProjectStatus = 'active' | 'maintenance' | 'paused' | 'archived';
export type KnowledgeStatus = 'draft' | 'accepted' | 'rejected' | 'needs_recheck' | 'archived';
export type ID = string;

export interface Versioned {
  revision: number;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface Relevance {
  reason?: string;
  matchedGoals?: string[];
  matchedSkills?: string[];
}

export interface Project extends Versioned {
  id: ID;
  title: string;
  goal: string;
  status: ProjectStatus;
  lastCheckpoint?: Checkpoint | null;
}

export interface Checkpoint {
  id: ID;
  projectId: ID;
  progress: string;
  nextAction: string;
  openQuestion: string;
  createdAt: string;
}

export interface SourceRef {
  sourceId: ID;
  kind: 'codex' | 'manual_dialogue' | 'siyuan' | 'feishu' | 'manual' | string;
  externalId?: string | null;
  title: string;
  url?: string | null;
  threadId?: string | null;
  messageId?: string | null;
  documentId?: string | null;
  blockId?: string | null;
  excerpt?: string | null;
  contentDigest?: string | null;
  role?: 'user' | 'assistant' | null;
  occurredAt?: string | null;
  capturedAt?: string | null;
  redacted?: boolean | null;
}

export type SourceRefInput = { sourceId: ID } | {
  kind: 'manual';
  title: string;
  url: string | null;
  excerpt: string | null;
};

export interface EvidenceRef {
  kind: 'source' | 'output' | 'url';
  id: ID | null;
  url: string | null;
  label: string;
}

export interface Knowledge extends Versioned {
  id: ID;
  question: string;
  answer: string;
  projectId: ID | null;
  sourceRefs: SourceRef[];
  status: KnowledgeStatus;
  siyuanBlockId?: string | null;
  validation?: { status?: string; method?: string; notes?: string; evidenceRefs?: EvidenceRef[] };
  sync?: { status?: string; lastError?: { message?: string } | null };
  relevance?: Relevance;
  selectionReason?: string;
}

export interface Provenance {
  mode?: 'manual' | 'template' | 'model';
  label?: string;
  sourceRefs?: SourceRef[];
  profileRevision?: number | null;
  model?: { provider: string; model: string } | null;
  generatedAt?: string | null;
}

export interface DailyPlanItem {
  id: ID;
  title: string;
  kind: 'review' | 'practice' | 'output' | string;
  estimatedMinutes: number;
  state: 'pending' | 'completed' | 'blocked' | string;
  practiceId?: ID | null;
  outputId?: ID | null;
  goal?: string | null;
  skill?: string | null;
  provenance?: Provenance;
  selectionReason?: string;
  relevance?: Relevance;
}

export interface DailyPlan extends Versioned {
  id: ID | null;
  date: string;
  timeZone: string;
  profileRevision: number | null;
  budgetMinutes: number;
  scheduledMinutes: number;
  unallocatedMinutes: number;
  reviewDueCount: number | null;
  items: DailyPlanItem[];
  status: 'not_generated' | 'ready' | 'completed' | 'blocked' | 'stale' | string;
  notices?: { code: string; message: string }[];
  generationJobId?: ID | null;
}

export interface Dashboard {
  date?: string;
  timeZone?: string;
  profile: LearningProfile;
  goals: string[];
  reviewDueCount: number | null;
  recentCheckpoint?: (Checkpoint & { projectTitle?: string }) | null;
  dailyBudgetMinutes?: number;
  limitations: string[];
  dailyPlan: DailyPlan | null;
  connections?: Connection[];
}

export interface CodexThread {
  id: ID;
  title: string;
  projectPath?: string | null;
  updatedAt?: string;
  archived?: boolean;
  allowed?: boolean;
}

export interface CodexScope extends Versioned {
  enabled: boolean;
  allowedThreadIds: ID[];
  allowedProjectPaths: string[];
  excludedThreadIds: ID[];
  excludedProjectPaths: string[];
  includeArchived: boolean;
  allowManualImports: boolean;
}

export type CodexScopeInput = Omit<CodexScope, keyof Versioned>;

export interface ManualDialogueInput {
  projectId: string | null;
  title: string;
  externalSourceId: string;
  messages: { sourceMessageId: string; role: 'user' | 'assistant'; content: string; occurredAt: string | null }[];
}

export interface JobAck { jobId: ID; operationId: string }

export interface Job {
  id: ID;
  type?: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'uncertain' | 'cancelled' | string;
  commitState?: string;
  operationId?: string;
  progress?: { completed: number; total: number | null; unit?: string };
  syncedCount?: number;
  skippedCount?: number;
  result?: Record<string, unknown> | null;
  error?: string | null;
}

export interface ReviewSession {
  id: ID;
  projectId?: ID | null;
  status?: 'active' | 'completed' | 'blocked' | 'uncertain' | string;
  pendingJobId?: ID | null;
  reviewedCount?: number;
  limit?: number;
}

export interface ReviewPrompt {
  cardId: ID;
  presentationId: ID;
  prompt: string;
  done?: boolean;
  remaining?: number;
  state?: 'question' | 'empty' | 'uncertain' | 'rating_pending' | 'blocked' | string;
  jobId?: ID;
  failure?: { code?: string; message?: string };
  session?: ReviewSession;
}

export interface ReviewAnswer {
  cardId?: ID;
  presentationId?: ID;
  answer: string;
  sourceRefs: SourceRef[];
}

export interface RubricCriterion {
  id: ID;
  label: string;
  description: string;
  expectedEvidence: string[];
}

export interface Practice extends Versioned {
  id: ID;
  title: string;
  prompt: string;
  goal: string;
  skill: string;
  kind: 'explanation' | 'new_scenario' | 'artifact' | string;
  projectId: ID | null;
  sourceRefs: SourceRef[];
  rubric: RubricCriterion[];
  status?: 'open' | 'completed' | string;
  provenance?: Provenance;
  relevance?: Relevance;
  selectionReason?: string;
}

export type AssistanceLevel = 'none' | 'hint' | 'partial' | 'full' | 'unknown';

export interface PracticeAttempt {
  id: ID;
  practiceId: ID;
  output: string;
  assistanceLevel: AssistanceLevel;
  evidenceRefs: EvidenceRef[];
  feedback?: Feedback | null;
  submittedAt?: string;
}

export interface FeedbackObservation {
  criterionId: ID;
  finding: 'met' | 'partial' | 'not_met' | 'not_assessed';
  comment: string;
  evidenceRefs: EvidenceRef[];
}

export interface Feedback {
  id: ID;
  attemptId: ID;
  mode: 'model' | 'manual' | 'template';
  basis: string;
  summary: string;
  observations: FeedbackObservation[];
  nextActions: string[];
  limitations: string[];
  provenance?: Provenance;
  createdAt?: string;
}

export interface Output extends Versioned {
  id: ID;
  title: string;
  content: string;
  goal: string;
  status: 'draft' | 'final';
  projectId: ID | null;
  practiceId: ID | null;
  sourceRefs: SourceRef[];
  evidenceRefs: EvidenceRef[];
}

export type OutputInput = Omit<Output, 'id' | keyof Versioned | 'sourceRefs'> & { sourceRefs: SourceRefInput[] };

export interface LearningProfile extends Versioned {
  goals: string[];
  careerDirection: string;
  skills: string[];
  dailyBudgetMinutes: number;
  timeZone: string;
}

export type LearningProfileInput = Omit<LearningProfile, keyof Versioned>;

export interface Connection {
  provider: string;
  configured: boolean;
  connected?: boolean;
  status?: string;
  detail?: string;
  lastCheckedAt?: string | null;
  revision?: number;
  baseUrl?: string | null;
  notebookTitle?: string;
  tokenConfigured?: boolean;
  configurationSource?: string;
}

export type FeishuChatConnectionState = 'off' | 'setup' | 'connecting' | 'connected' | 'error';

export interface FeishuChatStatus {
  enabled: boolean;
  revision: number;
  remindersEnabled: boolean;
  reminderLocalTime: string;
  bound: boolean;
  configured: boolean;
  lastReceivedAt: string | null;
  lastSentAt: string | null;
  cardsEnabled?: boolean;
  lastCardActionAt?: string | null;
  state?: string;
  lastError?: { code: string; message: string; retryable: boolean } | null;
  snoozedUntil?: string | null;
  pendingMessages?: unknown;
  connection: {
    state: FeishuChatConnectionState;
    message: string;
    lastError: { code: string; message: string; retryable: boolean } | null;
  };
}

export type FeishuChatInput = Pick<FeishuChatStatus, 'enabled' | 'remindersEnabled' | 'reminderLocalTime'> & Partial<Pick<FeishuChatStatus, 'cardsEnabled'>>;
export interface FeishuChatEntry {
  url: string | null;
  qrDataUrl: string | null;
}
export interface FeishuRegistrationStatus {
  state: 'idle' | 'starting' | 'waiting' | 'complete' | 'error';
  url: string | null;
  qrDataUrl: string | null;
  expiresAt: string | null;
  message: string;
  error: { code: string; message: string; retryable: boolean } | null;
}
export interface FeishuChatPair { code: string; expiresAt: string }
export interface FeishuChatSendToday {
  queued: boolean;
  alreadySent: boolean;
  practiceId: string | null;
  completed?: boolean;
  deliveryState?: 'sent' | 'pending' | 'sending' | 'uncertain' | 'failed' | 'cancelled';
}

export interface Settings extends Versioned {
  model: {
    enabled: boolean;
    provider: 'openai-compatible';
    endpoint: string | null;
    model: string | null;
    allowExternalProcessing: boolean;
    apiKeyConfigured: boolean;
  };
  feishu: {
    enabled: boolean;
    appId: string | null;
    apiBase: 'https://open.feishu.cn' | 'https://open.larksuite.com';
    appSecretConfigured: boolean;
  };
  scheduler: {
    enabled: boolean;
    codexSyncEnabled: boolean;
    dailyPlanEnabled: boolean;
    codexSyncIntervalMinutes: number;
    dailyPlanLocalTime: string;
    catchUpEnabled: boolean;
  };
}

export interface SettingsInput {
  model: Omit<Settings['model'], 'apiKeyConfigured'> & { apiKey?: string | null };
  feishu: Omit<Settings['feishu'], 'appSecretConfigured'> & { appSecret?: string | null };
  scheduler: Settings['scheduler'];
}

export interface SiyuanInput {
  useRuntimeConnection: boolean;
  baseUrl: string | null;
  notebookTitle: string;
  token?: string | null;
}

export interface ExportArtifact {
  filename: string;
  mediaType: 'application/json';
  schemaVersion: string;
  content: string;
  byteLength: number;
  sha256: string;
}

export interface Automation {
  enabled: boolean;
  revision: number;
  state: 'off' | 'setup' | 'collecting' | 'organizing' | 'ready' | 'waiting' | 'limited' | 'error';
  message: string;
  setup: { profile: boolean; scope: boolean; model: boolean };
  dailyCallLimit: 3;
  callsToday: number;
  nextRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: { code: string; message: string; retryable: boolean } | null;
}

export interface AdviceSettings {
  enabled: boolean;
  dailyCallLimit: number;
  revision: number;
  callsToday: number;
  remainingToday: number;
  modelConfigured: boolean;
}

export type AdviceSettingsInput = Pick<AdviceSettings, 'enabled' | 'dailyCallLimit'>;

export type AdviceStatus = 'off' | 'idle' | 'queued' | 'running' | 'ready' | 'failed' | 'uncertain' | 'limited' | 'unavailable' | 'stale';

export interface AdviceState {
  attemptId: ID;
  status: AdviceStatus;
  jobId: ID | null;
  feedback: Feedback | null;
  message: string;
  canRequest: boolean;
  canRetry: boolean;
  lastError: { code: string; message: string; retryable: false } | null;
}

export interface TodayHighlight {
  id: string;
  title: string;
  summary: string;
  goal: string;
  whyRelevant: string;
  sourceRefs: SourceRef[];
}

export interface TodayData {
  date: string;
  profile: LearningProfile;
  automation: Automation;
  highlights: TodayHighlight[];
  practice: Practice | null;
  attempt: PracticeAttempt | null;
  generatedAt: string | null;
  adviceSettings?: AdviceSettings;
  advice?: AdviceState | null;
}

export interface ListData<T> { items: T[]; total: number }
