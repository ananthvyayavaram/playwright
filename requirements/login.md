# Login Feature

## Overview
The login page allows registered users to authenticate with an email address and password.
It provides clear feedback on invalid credentials, empty fields, and already-authenticated sessions.

## User Story
As a registered user, I want to sign in with my credentials so that I can access the application.

---

## Acceptance Criteria

### Successful Login  `@smoke @login-valid`
- [ ] User can log in with a valid email and password
- [ ] After successful login, the user is **not** on the login page
- [ ] Auth state (cookie / localStorage token) is persisted across a page reload

### Invalid Credentials  `@negative @login-invalid`
- [ ] Entering an incorrect password with a valid email shows an error message
- [ ] The error message is visible without a page reload
- [ ] The user remains on the login page after a failed attempt

### Empty Field Validation  `@negative @login-empty`
- [ ] Submitting with an empty email shows a field-level error on the email input
- [ ] Submitting with an empty password shows a field-level error on the password input
- [ ] Submitting with both fields empty: the form is not submitted, user stays on login page

### UI / Accessibility  `@accessibility @login-ui`
- [ ] The email input is present and visible
- [ ] The password input is present and visible
- [ ] The submit button is present and visible
- [ ] Page has a non-empty document title
- [ ] A "Forgot password?" link is visible

### Edge Cases  `@negative @login-malformed`
- [ ] Entering a string without "@" in the email field keeps the user on the login page
- [ ] HTML/script tags in the email field do not cause a JavaScript error

### Session Redirect  `@login-session @login-redirect`
- [ ] An already-authenticated user who navigates to the login URL is redirected away
