import type { DecodeFailure } from '@raphael/contracts';
import { invalidRequestIssueFrom } from '@raphael/contracts/nodes';

import { InvalidInput } from './errors.ts';

/** Share safe decoder diagnostics with the client; never publish decoder text. */
export const invalidInputFrom = (failure: DecodeFailure, input: unknown): InvalidInput =>
  new InvalidInput(invalidRequestIssueFrom(failure, input));
