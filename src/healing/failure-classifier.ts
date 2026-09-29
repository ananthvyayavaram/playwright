import type { FailureType, FailureCategory } from './types';

// Ordered list: first match wins. More specific patterns come first.
const FAILURE_PATTERNS: Array<[RegExp, FailureType]> = [
  // Strict mode = multiple elements
  [/strict mode violation/i,                              'LOCATOR_NOT_UNIQUE'],
  [/resolved to (\d+) elements? \(/i,                    'LOCATOR_NOT_UNIQUE'],

  // Locator not found (various Playwright error phrasings)
  [/resolved to 0 elements/i,                            'LOCATOR_NOT_FOUND'],
  [/locator\..*?: timeout \d+ms exceeded.*waiting for/i, 'LOCATOR_NOT_FOUND'],
  [/waiting for locator\(/i,                             'LOCATOR_NOT_FOUND'],
  [/element.*not found/i,                                'LOCATOR_NOT_FOUND'],
  [/unable to find.*element/i,                           'LOCATOR_NOT_FOUND'],
  [/no element found/i,                                  'LOCATOR_NOT_FOUND'],

  // Element state problems
  [/not visible|is not visible|element.*hidden/i,        'ELEMENT_NOT_VISIBLE'],
  [/not enabled|is disabled|element.*disabled/i,         'ELEMENT_NOT_ENABLED'],
  [/intercepts pointer events|covered by another/i,      'ELEMENT_COVERED'],
  [/outside of the viewport/i,                           'ELEMENT_COVERED'],

  // Timeout (non-locator — e.g. page navigation, networkidle)
  [/navigation timeout/i,                                'TIMEOUT'],
  [/waitForLoadState.*timeout/i,                         'TIMEOUT'],
  [/timeout \d+ms exceeded/i,                            'TIMEOUT'],

  // Network / wrong page
  [/net::err_|err_name_not_resolved/i,                   'WRONG_PAGE'],
  [/navigation failed|failed to navigate/i,              'WRONG_PAGE'],
  [/page.*crashed|target.*closed/i,                      'WRONG_PAGE'],

  // Dialogs/popups blocking interaction
  [/unexpected.*alert|dialog.*appeared/i,                'DIALOG_PRESENT'],
  [/modal.*intercepting|overlay.*blocking/i,             'POPUP_OR_MODAL'],

  // iFrames
  [/frame.*detached|framelocator.*timeout/i,             'FRAME_CHANGED'],

  // Assertion failures (expects)
  [/expect\([^)]*\)\.[a-z]+\s*\(/i,                     'ASSERTION_FAILURE'],
  [/assertionError|assertion failed/i,                   'ASSERTION_FAILURE'],
  [/toBeVisible\(\)|toHaveText\(|toContainText\(/i,      'ASSERTION_FAILURE'],
  [/received.*expected|expected.*received/i,             'ASSERTION_FAILURE'],
];

// Patterns that suggest a real product defect — healing must NOT be applied.
// These are assertion mismatches on data values, not locator problems.
const APPLICATION_FAILURE_SIGNALS: RegExp[] = [
  /expected\s+['"]?\$[\d,. ]+['"]?\s+(?:to )?(?:be|equal)/i,  // money amount mismatch
  /expected\s+\d[\d,. ]+\s+(?:to )?(?:be|equal)\s+\d/i,       // numeric mismatch
  /toHaveText.*but got/i,                                        // wrong displayed text (data issue)
  /toEqual.*but received/i,                                      // data equality failure
  /expected.*null.*received|received.*null.*expected/i,          // null vs non-null assertion
];

export function classifyFailure(errorMessage: string, stackTrace?: string): FailureType {
  const combined = `${errorMessage}\n${stackTrace ?? ''}`;
  for (const [pattern, type] of FAILURE_PATTERNS) {
    if (pattern.test(combined)) return type;
  }
  return 'UNKNOWN';
}

export function classifyFailureCategory(
  errorMessage: string,
  stackTrace: string,
  failureType: FailureType,
): FailureCategory {
  // Only assertion failures can be application failures
  if (failureType !== 'ASSERTION_FAILURE') return 'AUTOMATION_FAILURE';

  const combined = `${errorMessage}\n${stackTrace}`;
  for (const signal of APPLICATION_FAILURE_SIGNALS) {
    if (signal.test(combined)) return 'APPLICATION_FAILURE';
  }
  return 'AUTOMATION_FAILURE';
}

/** One-line summary of why this type cannot be auto-healed */
export function cannotHealReason(
  failureType: FailureType,
  failureCategory: FailureCategory,
): string | null {
  if (failureCategory === 'APPLICATION_FAILURE') {
    return 'Assertion failure involves data values — this is a product defect, not an automation issue';
  }
  switch (failureType) {
    case 'UNKNOWN':
      return 'Could not classify failure from error output';
    case 'NETWORK_DELAY':
      return 'Network/environment issue — not a locator problem';
    case 'WRONG_PAGE':
      return 'Page navigation failed — requires flow-level repair';
    default:
      return null;
  }
}
