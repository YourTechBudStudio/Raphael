import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DIRECT_ARCHIVE_REASON,
  USER_ARCHIVE_OWNER,
  archiveStandingOf,
  hasDirectUserCause,
  type ArchiveCause,
} from './archive.ts';

const cause = (
  id: number,
  type: ArchiveCause['origin']['type'],
  owner = USER_ARCHIVE_OWNER,
  reason = DIRECT_ARCHIVE_REASON,
): ArchiveCause => ({ origin: { id, type, title: `Node ${id}` }, owner, reason });

test('the ADR 0003 example reads the same from a cause list as the server computed it', () => {
  // Project 10 carries cause B; note 11 carries none; note 12 carries its own cause A.
  const project = [cause(10, 'project')];
  const plainNote = [cause(10, 'project')];
  const independentNote = [cause(12, 'resource'), cause(10, 'project')];

  assert.equal(archiveStandingOf(10, project), 'direct');
  assert.equal(hasDirectUserCause(10, project), true);

  assert.equal(archiveStandingOf(11, plainNote), 'inherited');
  assert.equal(hasDirectUserCause(11, plainNote), false);

  assert.equal(archiveStandingOf(12, independentNote), 'direct');
  assert.equal(hasDirectUserCause(12, independentNote), true);

  // After restoring 10, the server reports 11 active and 12 archived by its own cause alone.
  assert.equal(archiveStandingOf(11, []), 'active');
  assert.equal(archiveStandingOf(12, [cause(12, 'resource')]), 'direct');
});

test('a direct cause of another owner is direct standing without ordinary restore', () => {
  const causes = [cause(5, 'area', 'ext_calendar', 'expired')];
  assert.equal(archiveStandingOf(5, causes), 'direct');
  assert.equal(hasDirectUserCause(5, causes), false);

  // The user's own cause beside it is what makes restore apply.
  assert.equal(hasDirectUserCause(5, [...causes, cause(5, 'area')]), true);
  // A user cause with another reason is not the user's direct cause.
  assert.equal(hasDirectUserCause(5, [cause(5, 'area', USER_ARCHIVE_OWNER, 'bulk')]), false);
});
