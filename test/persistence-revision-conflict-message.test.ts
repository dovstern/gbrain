/**
 * requestError() previously discarded PageRevisionConflictError's own
 * message and replaced every revision_conflict with a generic string that
 * always implies a client supplied a now-stale revision. That's wrong (and
 * misleading) for the equally common case where no expected_revision was
 * supplied at all for a mutation of an existing page — the error class
 * already distinguishes the two; the coordinator just wasn't using it.
 */
import { expect, test } from 'bun:test';
import { OperationError } from '../src/core/ops/contract.ts';
import { PageRevisionConflictError } from '../src/core/page-state/types.ts';
import { requestError } from '../src/core/persistence/coordinator.ts';

test('a missing expected_revision is reported distinctly from a stale one', () => {
  const missing = requestError(new PageRevisionConflictError(null, 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'));
  expect(missing.code).toBe('revision_conflict');
  expect(missing.message).toBe('The page already exists; an expected revision is required.');

  const stale = requestError(new PageRevisionConflictError('11111111-1111-1111-1111-111111111111', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'));
  expect(stale.code).toBe('revision_conflict');
  expect(stale.message).toBe('The page changed after it was read. Read its current revision before retrying.');

  expect(missing.message).not.toBe(stale.message);
});

test('a non-Error revision_conflict-coded value still falls back to a generic message', () => {
  const result = requestError({ code: 'revision_conflict' });
  expect(result).toEqual({ code: 'revision_conflict', message: 'The page changed after the supplied revision was read.' });
});

test('OperationError and unrelated errors are unaffected', () => {
  expect(requestError(new OperationError('page_not_found', 'nope'))).toEqual({ code: 'page_not_found', message: 'nope' });
  expect(requestError(new Error('boom'))).toEqual({ code: 'storage_error', message: 'Publication failed. Inspect owner diagnostics.' });
});
