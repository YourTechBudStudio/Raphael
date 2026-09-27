import { emblemFor } from '../../../../ui';

/**
 * Temporary: favorites mock for story #14. One invented world shared by the Favorites and Search
 * mocks. Nothing here is read from or sent to a server.
 */

export type MockKind = 'area' | 'project' | 'note';

export interface MockItem {
  readonly id: number;
  readonly kind: MockKind;
  readonly title: string;
  readonly parentId: number | null;
}

/** Areas and projects. A long title is included on purpose, to see how each row style wraps. */
export const CONTAINERS: readonly MockItem[] = [
  { id: 1, kind: 'area', title: 'Raphael', parentId: null },
  { id: 2, kind: 'project', title: 'Mobile app', parentId: 1 },
  { id: 3, kind: 'project', title: 'Backend', parentId: 1 },
  { id: 4, kind: 'project', title: 'Web', parentId: 1 },
  { id: 5, kind: 'area', title: 'Home', parentId: null },
  { id: 6, kind: 'area', title: 'Kitchen', parentId: 5 },
  { id: 8, kind: 'project', title: 'Recipes', parentId: 6 },
  { id: 10, kind: 'project', title: 'Garden', parentId: 5 },
  { id: 11, kind: 'area', title: 'Work', parentId: null },
  { id: 12, kind: 'project', title: 'Hiring', parentId: 11 },
  { id: 14, kind: 'project', title: 'Q4 planning', parentId: 11 },
  { id: 15, kind: 'area', title: 'Health', parentId: null },
  { id: 16, kind: 'project', title: 'Running', parentId: 15 },
  { id: 17, kind: 'area', title: 'Learning', parentId: null },
  { id: 18, kind: 'project', title: 'Reading list', parentId: 17 },
  {
    id: 20,
    kind: 'project',
    title: 'Notes from the distributed systems course, second attempt',
    parentId: 17,
  },
];

/**
 * The mock's ids are mostly even, which would draw every project with petals; mixing in the title
 * length spreads petals and arches. Used by the big mark and the parent chip alike, so they agree.
 */
export const projectEmblem = (item: MockItem) => emblemFor('project', item.id + item.title.length);

export const INITIAL_FAVORITES: readonly number[] = [1, 2, 8, 12, 14, 15, 18, 20];

const byId = new Map(CONTAINERS.map((item) => [item.id, item]));

export const titleOf = (id: number | null): string | null =>
  id === null ? null : (byId.get(id)?.title ?? null);

export const parentOf = (item: MockItem): MockItem | null =>
  item.parentId === null ? null : (byId.get(item.parentId) ?? null);

const byTitle = (a: MockItem, b: MockItem) =>
  a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }) || a.id - b.id;

/** The favorites the server list would return: containers only, title then id. */
export const favoriteItems = (ids: ReadonlySet<number>): readonly MockItem[] =>
  CONTAINERS.filter((item) => ids.has(item.id)).sort(byTitle);

const NOTE_TITLES = [
  'Sourdough starter feeding schedule',
  'Interview loop for mobile engineers',
  'Sync protocol open questions',
  'Tomato planting plan',
  'Half marathon training plan',
  'Offline capture edge cases',
  'Weekly grocery list',
  'Hiring rubric draft',
  'Planning notes from the offsite',
  'Books to read this winter',
  'Search ranking ideas',
  'Pasta dough ratios',
  'Compost bin setup',
  'Release checklist',
  'Knee rehab exercises',
  'Onboarding plan for new hires',
  'Pagination contract sketch',
  'Winter garden plan',
  'Budget planning for Q4',
  'Reading notes: Designing Data-Intensive Applications',
];
const NOTE_PARENTS = [8, 12, 3, 10, 16, 2, 6, 12, 14, 18, 3, 8, 10, 2, 16, 12, 4, 10, 14, 20];

/**
 * The ranked answer any non-empty search returns in this mock: areas, projects and notes
 * interleaved as a server ranking would leave them. Titles repeat past the first twenty with
 * a number, so there is enough to scroll through several pages.
 */
export const SEARCH_RESULTS: readonly MockItem[] = (() => {
  const notes: MockItem[] = Array.from({ length: 44 }, (_, index) => {
    const base = index % NOTE_TITLES.length;
    const round = Math.floor(index / NOTE_TITLES.length);

    return {
      id: 100 + index,
      kind: 'note',
      title: round === 0 ? NOTE_TITLES[base]! : `${NOTE_TITLES[base]!} (${String(round + 1)})`,
      parentId: NOTE_PARENTS[base]!,
    };
  });
  const containers = [14, 1, 12, 10, 8, 18].map((id) => byId.get(id)!);
  const ranked: MockItem[] = [];

  // A container every few notes, early on, so kinds visibly interleave on the first page.
  notes.forEach((note, index) => {
    if (index % 3 === 1 && containers.length > 0) ranked.push(containers.shift()!);
    ranked.push(note);
  });

  return ranked;
})();

export const SEARCH_PAGE = 12;

/** Results that are archived: hidden unless the search includes archived, then marked. */
export const ARCHIVED_RESULTS: ReadonlySet<number> = new Set([104, 111, 118, 127]);
