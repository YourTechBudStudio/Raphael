/**
 * The one `unsent` table and its runner, opened once for the app, and what screens do with them.
 *
 * Screens never send anything: they write rows, and the runner sends them.
 */

import { create as createNode, get as getNode, getPath, update } from '@raphael/client/nodes';
import { createEmptyDocument } from '@raphael/content';
import type { NodeEntity, NodeType, ResourceKind } from '@raphael/contracts/nodes';
import { randomUUID } from 'expo-crypto';
import { AppState } from 'react-native';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

import { invalidateActivation } from '../../../infrastructure/query/invalidate';
import { nodeKey } from '../../../infrastructure/query/keys';
import { queryClient } from '../../../infrastructure/query/query-client';
import { migrate, sqlDriver, type SqlDriver } from '../../../infrastructure/sqlite';
import { isOnline, onBackOnline, useConnectionStore } from '../../connection';
import {
  createProblem,
  hasWriting,
  isUnfinished,
  sameContent,
  sameWriting,
  slugFor,
  titleFor,
  type CreateProblem,
  type Destination,
  type UnsentContent,
  type UnsentRow,
} from '../row.ts';
import { createRunner, type Runner, type RunnerSession, type Synced } from '../runner.ts';
import { DATABASE_NAME, MIGRATIONS, openUnsentStore, type UnsentStore } from '../store.ts';

/** The database the old capture machinery kept. Nothing reads it any more. */
const OLD_DATABASE = 'raphael-capture.db';

/** Edits are sent once typing pauses for this long. */
const EDIT_DEBOUNCE_MS = 1_000;

interface UnsentState {
  readonly status: 'opening' | 'ready' | 'failed';
  readonly rows: readonly UnsentRow[];
}

/** Screens read this through the hooks below; tests seed it directly. */
export const useUnsentState = create<UnsentState>(() => ({ status: 'opening', rows: [] }));

let store: UnsentStore | null = null;
let runner: Runner | null = null;
let starting: Promise<void> | null = null;
/**
 * Set by a server switch's wipe, until the next connection activates: any write in between comes
 * from a screen of the old server on its way out, and is refused rather than left for the new one.
 */
let sealed = false;
let debounce: ReturnType<typeof setTimeout> | null = null;

const session = (): RunnerSession | null => {
  const { phase } = useConnectionStore.getState();

  return phase.kind === 'active' && phase.rejection === null
    ? { activation: phase.session.activation, transport: phase.session.transport }
    : null;
};

/**
 * Opens the table and starts the runner. Called once from root composition; safe to repeat. Tests
 * pass a Node SQLite driver.
 */
export const startUnsent = (driver: SqlDriver = sqlDriver): Promise<void> => {
  starting ??= open(driver);

  return starting;
};

/** Stops the runner's timers. For tests, which must not leave a backoff holding the process open. */
export const stopUnsent = (): void => {
  runner?.stop();
};

const open = async (driver: SqlDriver): Promise<void> => {
  try {
    await driver.remove(OLD_DATABASE).catch(() => undefined);

    const db = await driver.open(DATABASE_NAME);
    const migrated = await migrate(db, MIGRATIONS);

    if (migrated.kind !== 'ready') throw new Error(`unsent: migration ${migrated.kind}`);

    const opened = await openUnsentStore(db, (message) => {
      console.warn(message);
    });

    store = opened;
    runner = createRunner({
      store: opened,
      session,
      online: isOnline,
      create: (transport, request) => createNode(transport, request),
      update: (transport, request) => update(transport, request),
      get: (transport, target) => getNode(transport, { target, format: 'tiptap' }),
      pathOf: async (transport, id) => {
        const result = await getPath(transport, { target: { id } });

        return result.ok ? { ok: true, value: result.value.path } : result;
      },
      cache: (entity, activation) => {
        queryClient.setQueryData(nodeKey(activation, entity.id), entity);
      },
      refresh: (activation) => {
        void invalidateActivation(queryClient, activation);
      },
      setTimer: (run, ms) => {
        const timer = setTimeout(run, ms);

        return () => {
          clearTimeout(timer);
        };
      },
    });

    opened.subscribe(() => {
      useUnsentState.setState({ rows: opened.rows() });
    });
    useUnsentState.setState({ status: 'ready', rows: opened.rows() });

    const live = runner;

    onBackOnline(live.kick);
    // A switch has already discarded the old server's rows before it activates (see `SetupScreen`).
    useConnectionStore.subscribe((state, previous) => {
      const activation = state.phase.kind === 'active' ? state.phase.session.activation : null;
      const before = previous.phase.kind === 'active' ? previous.phase.session.activation : null;

      if (activation !== null && activation !== before) {
        sealed = false;
        live.kick();
      }
    });
    AppState.addEventListener('change', (next) => {
      if (next === 'active') live.kick();
    });
    live.kick();
  } catch (cause) {
    console.warn('unsent: could not open storage', cause);
    useUnsentState.setState({ status: 'failed' });
  }
};

/* ----------------------------------------------------------------------------------- reading */

export const useUnsentStatus = (): UnsentState['status'] => useUnsentState((state) => state.status);

export const useUnsentRow = (id: string): UnsentRow | undefined =>
  useUnsentState((state) => state.rows.find((row) => row.id === id));

export const useNodeUnsent = (nodeId: number | null): UnsentRow | undefined =>
  useUnsentState((state) =>
    nodeId === null
      ? undefined
      : state.rows.find((row) => row.op === 'edit' && row.nodeId === nodeId),
  );

/** What Unfinished lists: rows that need the person or are stuck, not rows syncing normally. */
export const useUnfinished = (): readonly UnsentRow[] =>
  useUnsentState(useShallow((state) => state.rows.filter(isUnfinished)));

/** Everything a server switch would discard. */
export const useUnsentCount = (): number => useUnsentState((state) => state.rows.length);

/* ----------------------------------------------------------------------------------- writing */

const now = (): number => Date.now();

/** A write that could not reach SQLite answers false; the screen says so and nothing else. */
const guarded = async (write: () => Promise<unknown>): Promise<boolean> => {
  if (sealed) return false;

  try {
    await write();

    return true;
  } catch (cause) {
    console.warn('unsent: a local write failed', cause);

    return false;
  }
};

export interface NewItem {
  readonly nodeType: NodeType;
  readonly kind: ResourceKind | null;
  readonly destination: Destination | null;
}

/** A new draft row for a composer or sheet to write into. Null when storage is not open. */
export const startDraft = async (item: NewItem): Promise<string | null> => {
  const live = store;

  if (live === null) return null;

  const id = randomUUID();
  const written = await guarded(() =>
    live.change({ id }, () => ({
      id,
      op: 'create',
      nodeType: item.nodeType,
      kind: item.kind,
      nodeId: null,
      baseRevision: null,
      destination: item.destination,
      title: '',
      description: '',
      slug: '',
      tags: [],
      body: createEmptyDocument(),
      status: 'draft',
      error: null,
      version: 1,
      sentVersion: 0,
      updatedAt: now(),
    })),
  );

  return written ? id : null;
};

export type CreatePatch = Partial<UnsentContent & { readonly destination: Destination | null }>;

/** A write that changes nothing is not made, so a final flush never bumps a version for nothing. */
export const writeDraft = (id: string, patch: CreatePatch): Promise<boolean> =>
  guarded(async () =>
    store?.change({ id }, (row) => {
      if (row === undefined) return undefined;

      const next = { ...row, ...patch };

      return sameWriting(next, row) &&
        JSON.stringify(next.destination) === JSON.stringify(row.destination)
        ? undefined
        : { ...next, version: row.version + 1, updatedAt: now() };
    }),
  );

/** Leaving a composer or sheet: a draft with nothing written in it is not kept. Answers whether it was. */
export const leaveDraft = async (id: string): Promise<boolean> => {
  await guarded(async () =>
    store?.change({ id }, (row) =>
      row !== undefined && row.status === 'draft' && !hasWriting(row) ? null : undefined,
    ),
  );

  return store?.rows().some((row) => row.id === id) ?? false;
};

export type SaveResult =
  | { readonly kind: 'invalid'; readonly problem: CreateProblem }
  | { readonly kind: 'unwritable' }
  | ({ readonly kind: 'sent' } & Synced);

/**
 * Save: fix the title and slug, mark the row pending, and wait for its first answer. Checked inside
 * the write, so it sees every keystroke written before it.
 */
export const saveDraft = async (id: string): Promise<SaveResult> => {
  const live = store;
  const sender = runner;

  if (live === null || sender === null) return { kind: 'unwritable' };

  let problem: CreateProblem | null = null;
  const saved = await guarded(() =>
    live.change({ id }, (row) => {
      if (row === undefined) return undefined;

      problem = createProblem(row);
      if (problem !== null) return undefined;

      const title = titleFor(row) ?? '';

      return {
        ...row,
        title,
        slug: slugFor(title) ?? '',
        status: 'pending',
        error: null,
        updatedAt: now(),
      };
    }),
  );

  if (problem !== null) return { kind: 'invalid', problem };
  if (!saved || !live.rows().some((row) => row.id === id)) return { kind: 'unwritable' };

  return { kind: 'sent', ...(await sender.sync(id)) };
};

/** One edit to a node the server holds. The first one creates the row. */
export const writeEdit = async (
  nodeId: number,
  patch: Partial<UnsentContent>,
): Promise<boolean> => {
  const live = store;

  if (live === null) return false;

  const written = await guarded(() =>
    live.change({ nodeId }, (row) => {
      if (row !== undefined) {
        // Nothing changed, so a refused edit is not sent again and no version is spent.
        if (sameWriting({ ...row, ...patch }, row)) return undefined;

        const refused = row.status === 'refused';

        return {
          ...row,
          ...patch,
          status: refused ? 'pending' : row.status,
          error: refused ? null : row.error,
          version: row.version + 1,
          updatedAt: now(),
        };
      }

      // Read here, inside the write, so a save that just landed has already moved the cache on. A
      // node the current connection has not read is one an editor from before a server switch is
      // still writing on its way out: that writing belonged to the old server, and is not kept.
      const activation = session()?.activation ?? -1;
      const base = queryClient.getQueryData<NodeEntity>(nodeKey(activation, nodeId));

      if (base === undefined) return undefined;

      const next: UnsentRow = {
        id: randomUUID(),
        op: 'edit',
        nodeType: base.type,
        kind: base.kind,
        nodeId: base.id,
        baseRevision: base.revision,
        destination: null,
        title: base.title,
        description: base.description,
        slug: base.slug,
        tags: base.tags,
        body: base.body.value,
        ...patch,
        status: 'pending',
        error: null,
        version: 1,
        sentVersion: 0,
        updatedAt: now(),
      };

      return sameContent(next, base) ? undefined : next;
    }),
  );

  if (written) {
    if (debounce !== null) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      runner?.wake();
    }, EDIT_DEBOUNCE_MS);
  }

  return written;
};

/** Drops a row. For a conflict this is "Take server's". */
export const discardUnsent = (id: string): Promise<boolean> =>
  guarded(async () => store?.change({ id }, (row) => (row === undefined ? undefined : null)));

/** "Keep mine": send this writing again at whatever revision the server holds now. */
export const keepMine = async (id: string): Promise<boolean> => {
  const row = store?.rows().find((candidate) => candidate.id === id);
  const current = session();

  if (row === undefined || row.nodeId === null || current === null) return false;

  const read = await getNode(current.transport, { target: { id: row.nodeId }, format: 'tiptap' });

  if (!read.ok) return false;

  const written = await guarded(async () =>
    store?.change({ id }, (latest) =>
      latest === undefined
        ? undefined
        : { ...latest, baseRevision: read.value.entity.revision, status: 'pending', error: null },
    ),
  );

  runner?.kick();

  return written;
};

/** "Try now" on a row waiting to sync. */
export const retryNow = (id: string): Promise<Synced> =>
  runner === null ? Promise.resolve({ outcome: 'waiting', entity: null }) : runner.sync(id);

/** Switching servers discards everything unsent. Answers whether it is gone. */
export const discardAllUnsent = async (): Promise<boolean> => {
  const live = store;

  if (live === null) return false;

  // Sealed before the delete is queued, so no write can be queued behind it.
  sealed = true;

  try {
    await live.clear();

    return true;
  } catch (cause) {
    console.warn('unsent: could not discard for a server switch', cause);
    sealed = false;

    return false;
  }
};

/** A switch that did not happen after all: this server's screens may write again. */
export const resumeUnsent = (): void => {
  sealed = false;
};
