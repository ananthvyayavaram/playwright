export type FailureType =
  | 'LOCATOR_NOT_FOUND'
  | 'LOCATOR_NOT_UNIQUE'
  | 'ELEMENT_NOT_VISIBLE'
  | 'ELEMENT_NOT_ENABLED'
  | 'ELEMENT_COVERED'
  | 'TIMEOUT'
  | 'WRONG_PAGE'
  | 'NAVIGATION_CHANGED'
  | 'DYNAMIC_CONTENT'
  | 'POPUP_OR_MODAL'
  | 'FRAME_CHANGED'
  | 'DIALOG_PRESENT'
  | 'NETWORK_DELAY'
  | 'ASSERTION_FAILURE'
  | 'FLOW_CHANGED'
  | 'UNKNOWN';

export type HealingDecision =
  | 'HEAL_LOCATOR'
  | 'HEAL_ACTION'
  | 'HEAL_WAIT'
  | 'HEAL_FRAME'
  | 'HEAL_POPUP'
  | 'HEAL_NAVIGATION'
  | 'HEAL_FLOW'
  | 'RETRY'
  | 'SKIP'
  | 'ABORT';

export type HealingSource = 'MEMORY' | 'DETERMINISTIC' | 'LLM' | 'FALLBACK';

export type FailureCategory = 'AUTOMATION_FAILURE' | 'APPLICATION_FAILURE';

/** Describes the specific failing step extracted from TypeScript source + stack trace */
export interface FailedStepInfo {
  /** CSS/attribute/role selector string, e.g. '#login-btn' */
  locator: string;
  /** Full Playwright locator call found on the failing line, e.g. "locator('#login-btn')" */
  locatorCall: string;
  /** Which Playwright method was used: 'locator' | 'getByTestId' | 'getByRole' | etc. */
  locatorMethod: string;
  /** The action that failed: 'click' | 'fill' | 'check' | 'hover' | etc. */
  action: string;
  /** Absolute path to the file that contains the failing call */
  filePath: string;
  /** 1-based line number of the failing locator call */
  lineNumber: number;
  /** If inside a POM method, the method name (e.g. 'clickLoginButton') */
  methodName?: string;
  /** If locator is via a property (this.loginBtn), the property name */
  propertyName?: string;
  /** If locator is in an object group (this.group.key), the group name */
  groupName?: string;
  /** Semantic tokens derived from locator + method name + comments */
  intentTokens: string[];
  /** Human-readable intent phrase, e.g. 'Login button' */
  intentPhrase: string;
  /** 3 lines before + failing line + 3 lines after for context */
  surroundingCode: string;
}

/** Everything the healing pipeline knows about a failing test */
export interface HealingContext {
  testTitle: string;
  specPath: string;
  pomPaths: string[];
  errorMessage: string;
  stackTrace: string;
  /** URL where the element should be found; extracted from spec/env */
  currentUrl: string;
  /** Full MD flow description if available */
  mdDescription?: string;
  /** 1-based attempt number in the healing loop */
  attemptNumber: number;
}

/** A DOM element candidate found on the live page */
export interface PageElement {
  tag: string;
  id?: string;
  text?: string;
  role?: string;
  testId?: string;
  ariaLabel?: string;
  name?: string;
  placeholder?: string;
  type?: string;
  href?: string;
  visible: boolean;
  enabled: boolean;
  /** Position in the DOM query result list */
  index: number;
}

/** A scored locator candidate for the failed element */
export interface LocatorCandidate {
  /** The Playwright expression suffix, e.g. "getByRole('button', {name:'Login'})" */
  expression: string;
  /** The actual CSS/selector string if css-based, else same as expression */
  selector: string;
  /** Which strategy found this candidate */
  strategy: string;
  /** 0.0–1.0 confidence that this is the right element */
  confidence: number;
  /** Human-readable reason for the score */
  reason: string;
  element?: PageElement;
}

/** A persisted healing result stored in healing-memory.json */
export interface HealingMemoryEntry {
  /** Normalized URL path (without query/hash) */
  page: string;
  originalLocator: string;
  healedExpression: string;
  action: string;
  confidence: number;
  validated: boolean;
  timestamp: string;
  successCount: number;
  lastUsed: string;
}

/** Result of a single healing pipeline invocation */
export interface HealingResult {
  success: boolean;
  failureType: FailureType;
  failureCategory: FailureCategory;
  decision?: HealingDecision;
  source?: HealingSource;
  originalLocator?: string;
  healedExpression?: string;
  confidence?: number;
  tokensUsed: number;
  llmUsed: boolean;
  validationPassed?: boolean;
  /** True = the fast path failed and the caller should fall back to repairFlow */
  fallbackRequired: boolean;
  error?: string;
  stepInfo?: FailedStepInfo;
}

/** Per-test entry in the healing report */
export interface StepHealingReport {
  testTitle: string;
  spec: string;
  failedStep: string;
  originalLocator: string;
  failureType: FailureType;
  failureCategory: FailureCategory;
  healingDecision?: HealingDecision;
  healedExpression?: string;
  confidence?: number;
  healingSource?: HealingSource;
  validationResult?: string;
  llmUsed: boolean;
  tokensUsed: number;
  result: 'HEALED' | 'FAILED' | 'SKIPPED' | 'NOT_AUTOMATABLE';
  notes?: string;
}

export interface HealingConfig {
  /** Auto-heal without LLM when confidence >= this value (default 0.90) */
  thresholdAutoHeal: number;
  /** Ask LLM when confidence >= this value (default 0.50) */
  thresholdLlmAssist: number;
  /** Max candidate locators to evaluate per step (default 5) */
  maxCandidates: number;
  /** Max LLM calls per failing step (default 1) */
  maxLlmCallsPerStep: number;
  /** Max healing attempts across all strategies (default 3) */
  maxHealAttempts: number;
  /** Minimum stored successes before trusting cached healing (default 3) */
  memoryMinSuccess: number;
  memoryPath: string;
  reportPath: string;
  /** Path to Playwright storage state for authenticated page inspection */
  storageStatePath: string;
}

export const DEFAULT_HEALING_CONFIG: HealingConfig = {
  thresholdAutoHeal: 0.90,
  thresholdLlmAssist: 0.35,  // lowered: consult LLM even for weaker DOM candidates
  maxCandidates: 8,           // raised: give LLM more choices to reason from
  maxLlmCallsPerStep: 1,
  maxHealAttempts: 3,
  memoryMinSuccess: 3,
  memoryPath: 'test-results/healing-memory.json',
  reportPath: 'test-results/healing-report.json',
  storageStatePath: 'storageState.json',
};

/** Failure types that are purely locator-related (fast deterministic path applies) */
export const LOCATOR_FAILURE_TYPES: FailureType[] = [
  'LOCATOR_NOT_FOUND',
  'LOCATOR_NOT_UNIQUE',
  'ELEMENT_NOT_VISIBLE',
  'ELEMENT_NOT_ENABLED',
  'ELEMENT_COVERED',
];

export function isLocatorFailure(type: FailureType): boolean {
  return LOCATOR_FAILURE_TYPES.includes(type);
}
