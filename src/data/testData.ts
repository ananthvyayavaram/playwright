// Central test data — update these for your environment.
// Prefer reading from ENV for credentials; use this file for non-secret data
// (test content, expected labels, IDs, etc.).

import ENV from '../utils/env';

export const LoginData = {
  validUser: {
    email:    ENV.USERNAME ?? 'testuser@example.com',
    password: ENV.PASSWORD ?? 'TestP@ssw0rd',
  },
  invalidUser: {
    email:    'invalid@example.com',
    password: 'WrongPassword123',
  },
  partialUser: {
    emailOnly: {
      email:    ENV.USERNAME ?? 'testuser@example.com',
      password: '',
    },
    passwordOnly: {
      email:    '',
      password: ENV.PASSWORD ?? 'TestP@ssw0rd',
    },
  },
  malformed: {
    notAnEmail: 'notanemail',
    sqlInjection: "' OR 1=1 --",
    longString:  'a'.repeat(300),
  },
};

export const ExpectedMessages = {
  // TODO: Update these with your app's actual error messages.
  invalidCredentials: ['Invalid', 'incorrect', 'wrong', 'not found', 'Unauthorized'],
  emptyEmail:         ['required', 'enter', 'email', 'cannot be blank'],
  emptyPassword:      ['required', 'enter', 'password', 'cannot be blank'],
};
