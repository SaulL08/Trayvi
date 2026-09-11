import { HttpException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { toProblemDetails } from '../src/http/problem-details';
import { SafePublicError } from '../src/http/safe-public-error';

describe('safe Problem Details mapping', () => {
  it('maps an unexpected error to a stable envelope without internal detail', () => {
    const canary = 'C:\\private\\query.sql password=super-secret';
    const problem = toProblemDetails(new Error(canary), '018f4f7a-3c2b-7b11-8abc-0123456789ab');

    expect(problem).toEqual({
      type: 'about:blank',
      title: 'Internal server error',
      status: 500,
      code: 'INTERNAL_ERROR',
      requestId: '018f4f7a-3c2b-7b11-8abc-0123456789ab',
    });
    expect(JSON.stringify(problem)).not.toContain(canary);
  });

  it('does not reuse an HttpException response body as client detail', () => {
    const problem = toProblemDetails(
      new HttpException({ rawInput: 'restricted-canary' }, 400),
      '018f4f7a-3c2b-7b11-8abc-0123456789ab',
    );

    expect(problem.code).toBe('INVALID_REQUEST');
    expect(JSON.stringify(problem)).not.toContain('restricted-canary');
  });

  it.each([
    ['INVALID_IDENTITY_DOCUMENT_FORMAT', 400],
    ['IDEMPOTENCY_CONFLICT', 409],
    ['REQUEST_CANNOT_BE_COMPLETED', 409],
    ['RATE_LIMITED', 429],
  ] as const)('maps trusted Phase 1 errors without sensitive detail', (code, status) => {
    const problem = toProblemDetails(
      new SafePublicError(code),
      '018f4f7a-3c2b-7b11-8abc-0123456789ab',
    );

    expect(problem).toMatchObject({ code, status });
    expect(JSON.stringify(problem)).not.toContain('document');
    expect(JSON.stringify(problem)).not.toContain('account');
  });
});
