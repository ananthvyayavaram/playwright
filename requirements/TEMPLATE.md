# Requirements File Template

Requirements files (`.md`) describe user-facing feature behaviours in plain English.
They live in `requirements/<FeatureName>.md` and are the single source of truth for what tests should cover.

## Purpose

- Document what the feature does, not how it's implemented
- Drive test generation (`pfqa flow requirements/<feature>.md`)
- Communicate acceptance criteria between QA, Dev, and Product

---

## Format

```markdown
# <Feature Name>

## Overview
One paragraph describing the feature from a user's perspective.

## User Story
As a <persona>, I want to <action> so that <benefit>.

## Acceptance Criteria

### <Scenario Group 1>
- [ ] <criterion>
- [ ] <criterion>

### <Scenario Group 2>
- [ ] <criterion>
```

---

## Guidelines

- Write criteria as **observable outcomes**, not implementation details  
  ✓ "User sees an error message when they enter an invalid email"  
  ✗ "The `validateEmail()` function returns `false`"

- One criterion per line — keep it testable and atomic

- Use the same names as the `FOLDER_PHRASES` map in `src/ai/nl-runner.ts` so that  
  `pfqa "run login tests"` maps to `tests/Login/`

- Tag suggestions (used in test `@tag` annotations):
  | Tag | Meaning |
  |-----|---------|
  | `@smoke` | Must pass on every deploy |
  | `@regression` | Full regression suite |
  | `@negative` | Invalid / error-path tests |
  | `@accessibility` | UI structure / ARIA checks |
  | `@login-*` | Login feature sub-group |

---

## Example Requirement Snippet

```markdown
## Acceptance Criteria

### Successful Login
- [ ] User can log in with valid email + password
- [ ] After login, user is redirected away from the login page
- [ ] Auth cookie / session is persisted across page reloads

### Error Handling
- [ ] Invalid credentials show an error message
- [ ] Empty email field shows a field-level validation error
- [ ] Empty password field shows a field-level validation error
```
