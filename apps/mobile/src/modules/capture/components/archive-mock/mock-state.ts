/**
 * Temporary: archive mock for story #8. Presentation only; no owner, no transport, no server.
 *
 * Everything here is invented. The names, ids and the ancestry are fixtures chosen so each archive
 * standing can be shown: archived by you, archived with a container above, or both at once.
 */

import { useRef, useState } from 'react';

import { colors, type ToggleMark } from '../../../../ui';
import type { NoteSummaryItem } from '../../../resources';

/** Lucide Archive, redrawn as one closed outline so it can bloom like Active and Favorite. */
export const ARCHIVE_MARK: ToggleMark = {
  path: 'M3 3h18a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z',
  dropColor: colors.lilacDeep,
  inactiveColor: colors.ink,
};

/** Which causes apply. `mine` is the user's own direct cause; `parent` is one inherited from above. */
export interface MockLifecycle {
  readonly mine: boolean;
  readonly parent: boolean;
}

export const isArchived = (life: MockLifecycle): boolean => life.mine || life.parent;

/** The invented tree: Work holds Backend and the project; the note sits in the project. */
export type MockNode = 'work' | 'backend' | 'project' | 'note';

export const NODES: Record<
  MockNode,
  {
    readonly title: string;
    readonly kind: 'area' | 'project' | 'note';
    readonly parent: MockNode | null;
  }
> = {
  work: { title: 'Work', kind: 'area', parent: null },
  backend: { title: 'Backend', kind: 'area', parent: 'work' },
  project: { title: 'Authentication rework', kind: 'project', parent: 'work' },
  note: { title: 'Credential rotation runbook', kind: 'note', parent: 'project' },
};

const KIND_WORD = { area: 'Area', project: 'Project', note: 'Note' } as const;

/** "Area “Work”": the nearest archived container, named the way the design's copy names it. */
export const originName = (node: MockNode): string =>
  `${KIND_WORD[NODES[node].kind]} “${NODES[node].title}”`;

export interface MockStanding extends MockLifecycle {
  /** The nearest archived ancestor, or null when nothing above is archived. */
  readonly origin: MockNode | null;
}

/** How long the invented server takes to answer, so the busy ring can be seen. */
const ANSWER_MS = 700;

export interface MockWorld {
  standing(node: MockNode): MockStanding;
  readonly busy: MockNode | null;
  readonly failed: MockNode | null;
  readonly failNext: boolean;
  setFailNext(value: boolean): void;
  /** Flip the user's own cause on one node, after a pretend round trip. */
  toggle(node: MockNode): void;
  /** Jump a node straight to a standing, for the scenario chips. */
  force(node: MockNode, life: MockLifecycle): void;
}

/**
 * The user's own cause on each node, toggled against a pretend server.
 *
 * Standing is computed from ancestry exactly as the design computes it, so archiving Work visibly
 * archives the project inside it, and restoring Work leaves a project you archived yourself archived.
 * `failNext` makes the next answer a refusal so the "did not stick" line can be judged.
 */
export function useMockWorld(): MockWorld {
  const [own, setOwn] = useState<Record<MockNode, boolean>>({
    work: false,
    backend: false,
    project: false,
    note: false,
  });
  const [busy, setBusy] = useState<MockNode | null>(null);
  const [failed, setFailed] = useState<MockNode | null>(null);
  const [failNext, setFailNext] = useState(false);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);

  const origin = (node: MockNode): MockNode | null => {
    for (let at = NODES[node].parent; at !== null; at = NODES[at].parent) {
      if (own[at]) return at;
    }
    return null;
  };

  return {
    standing: (node) => {
      const nearest = origin(node);
      return { mine: own[node], parent: nearest !== null, origin: nearest };
    },
    busy,
    failed,
    failNext,
    setFailNext,
    toggle: (node) => {
      if (busy !== null) return;
      setBusy(node);
      setFailed(null);
      pending.current = setTimeout(() => {
        setBusy(null);
        if (failNext) {
          setFailed(node);
          setFailNext(false);
          return;
        }
        setOwn((current) => ({ ...current, [node]: !current[node] }));
      }, ANSWER_MS);
    },
    force: (node, life) => {
      if (pending.current !== null) clearTimeout(pending.current);
      setBusy(null);
      setFailed(null);
      setOwn((current) => {
        const next = { ...current, [node]: life.mine };
        // "With parent" is made true by archiving the nearest container above, and false by
        // clearing every container above, so the scenario is a real standing rather than a flag.
        const above = NODES[node].parent;
        if (above !== null) {
          for (let at: MockNode | null = above; at !== null; at = NODES[at].parent)
            next[at] = false;
          if (life.parent) next[above] = true;
        }
        return next;
      });
    },
  };
}

export const SCENARIOS: readonly { key: string; label: string; life: MockLifecycle }[] = [
  { key: 'active', label: 'Active', life: { mine: false, parent: false } },
  { key: 'mine', label: 'Archived by you', life: { mine: true, parent: false } },
  { key: 'parent', label: 'Archived with parent', life: { mine: false, parent: true } },
  { key: 'both', label: 'Both', life: { mine: true, parent: true } },
];

export const scenarioKey = (life: MockLifecycle): string =>
  SCENARIOS.find(
    (scenario) => scenario.life.mine === life.mine && scenario.life.parent === life.parent,
  )?.key ?? 'active';

const note = (
  id: number,
  title: string,
  description: string,
  parentId: number,
): NoteSummaryItem => ({
  id,
  title,
  description,
  slug: title.toLowerCase().replace(/\s+/g, '-'),
  revision: 3,
  parentId,
});

export const PROJECT_NOTES: readonly NoteSummaryItem[] = [
  note(41, 'Credential rotation runbook', 'Steps for rotating the API key without downtime.', 12),
  note(63, 'Auth flow sketch', '', 12),
  note(77, 'Token lifetime notes', 'Short-lived access, longer refresh. Numbers still open.', 12),
];

export const AREA_NOTES: readonly NoteSummaryItem[] = [
  note(88, 'On-call handover', 'What the next person needs to know on Monday.', 5),
];
