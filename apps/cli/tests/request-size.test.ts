import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';

import { REQUEST_MAX_BYTES } from '@raphael/contracts';
import { decodeCreateRequest, decodeUpdateRequest } from '@raphael/contracts/nodes';

import { errorResponse, runCli, stubServer } from './support/cli.ts';

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');

for (const command of ['create', 'update'] as const) {
  const requestWith = (value: string) =>
    command === 'create'
      ? {
          type: 'resource',
          kind: 'note',
          parent: { path: '/work' },
          slug: 'sized',
          title: 'Sized',
          body: { format: 'markdown', value },
          includePaths: true,
        }
      : {
          target: { id: 42 },
          revision: 1,
          body: { format: 'markdown', value },
          includePaths: true,
        };
  const decode = command === 'create' ? decodeCreateRequest : decodeUpdateRequest;
  const decoded = decode(requestWith(''));
  assert.equal(decoded._tag, 'Right');
  if (decoded._tag !== 'Right') throw new Error('Invalid fixture');
  const baseSize = bytes(decoded.right);

  for (const extra of [0, 1]) {
    it(`${command} measures omitted defaults: decoded limit + ${extra} bytes from @file`, async () => {
      const directory = mkdtempSync(join(tmpdir(), 'raphael-request-size-'));
      try {
        const body = 'a'.repeat(REQUEST_MAX_BYTES - baseSize + extra);
        const file = join(directory, 'body.md');
        writeFileSync(file, body);
        // Both raw requests fit. Only the decoded representation crosses the limit.
        assert.ok(bytes(requestWith(body)) <= REQUEST_MAX_BYTES);
        const server = stubServer(() => errorResponse(503, 'storage_busy', 'Busy.'));
        let connections = 0;
        const argv =
          command === 'create'
            ? ['create', 'resource.note', '/work/sized', '--title', 'Sized']
            : ['update', '--id', '42', '--revision', '1'];
        const ran = await runCli([...argv, '--body', `@${file}`, '--json'], {
          connect: () => {
            connections += 1;
            return server.connect();
          },
        });
        assert.equal(ran.stdout, '');
        if (extra === 0) {
          assert.equal(ran.code, 6, ran.stderr);
          assert.equal(connections, 1);
          assert.equal(server.requests.length, 1);
          assert.equal(bytes(server.requests[0]?.body), REQUEST_MAX_BYTES);
        } else {
          assert.equal(ran.code, 2, ran.stderr);
          assert.equal(connections, 0);
          assert.equal(server.requests.length, 0);
          assert.match(ran.stderr, /serialized request/u);
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
}

for (const command of ['get', 'update', 'move', 'archive', 'restore']) {
  it(`${command} checks defaults on its initial read before connecting`, async () => {
    const overhead = bytes({ target: { path: '/' } });
    const path = `/${'a'.repeat(REQUEST_MAX_BYTES - overhead)}`;
    assert.equal(bytes({ target: { path } }), REQUEST_MAX_BYTES);
    let connections = 0;
    const changes =
      command === 'update' ? ['--title', 'Sized'] : command === 'move' ? ['/personal'] : [];
    const ran = await runCli([command, path, ...changes, '--json'], {
      connect: () => {
        connections += 1;
        throw new Error('Must refuse before connection setup');
      },
    });
    assert.equal(ran.code, 2, ran.stderr);
    assert.equal(connections, 0);
    assert.equal(ran.stdout, '');
    assert.match(ran.stderr, /serialized request/u);
  });
}

for (const name of ['constructor', 'toString', '__proto__']) {
  it(`does not suggest an inherited alias for ${name}`, async () => {
    const ran = await runCli([name]);
    assert.equal(ran.code, 2);
    assert.match(ran.stderr, /is not a command/u);
    assert.doesNotMatch(ran.stderr, /Did you mean|native code|\[object/u);
  });
}
