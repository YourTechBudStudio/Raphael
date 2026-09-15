/**
 * THROWAWAY MOCK. Fake destinations for the capture-screen mocks, as a tree so the picker can draw
 * the same hierarchy Browse does. Nothing here touches the server.
 */

export interface MockNode {
  readonly type: 'area' | 'project';
  readonly id: number;
  readonly title: string;
  readonly children: readonly MockNode[];
}

export interface MockDestination {
  readonly type: 'area' | 'project';
  readonly id: number;
  readonly title: string;
  /** Titles of the ancestors, root first. Empty for a top-level area. */
  readonly path: readonly string[];
}

const area = (id: number, title: string, children: readonly MockNode[] = []): MockNode => ({
  type: 'area',
  id,
  title,
  children,
});
const project = (id: number, title: string): MockNode => ({
  type: 'project',
  id,
  title,
  children: [],
});

export const MOCK_TREE: readonly MockNode[] = [
  area(1, 'Creative work', [
    area(2, 'Design', [project(101, 'Portfolio site')]),
    area(3, 'Writing', [project(102, 'Essay on attention')]),
  ]),
  area(4, 'Home life', [project(103, 'Kitchen reno')]),
  area(5, 'Learning', [project(104, 'Rust book'), area(6, 'Notes')]),
];

/** Adds a created container under its parent, or at the root. */
export function withCreated(
  tree: readonly MockNode[],
  created: readonly { node: MockNode; parentId: number | null }[],
): readonly MockNode[] {
  return created.reduce<readonly MockNode[]>((current, { node, parentId }) => {
    if (parentId === null) return [...current, node];

    const insert = (nodes: readonly MockNode[]): readonly MockNode[] =>
      nodes.map((candidate) =>
        candidate.id === parentId
          ? { ...candidate, children: [...candidate.children, node] }
          : { ...candidate, children: insert(candidate.children) },
      );

    return insert(current);
  }, tree);
}

interface HierarchyLike {
  readonly id: number;
  readonly type: 'area' | 'project';
  readonly parentId: number | null;
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly children: readonly HierarchyLike[];
}

/** The mock tree as hierarchy nodes, for Browse. Slugs and descriptions are invented. */
export function toHierarchyNodes(
  nodes: readonly MockNode[],
  parentId: number | null = null,
): readonly HierarchyLike[] {
  return nodes.map((node) => ({
    id: node.id,
    type: node.type,
    parentId,
    slug: node.title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    title: node.title,
    description: node.type === 'project' ? 'Something with an end in sight.' : '',
    children: toHierarchyNodes(node.children, node.id),
  }));
}

export const describeDestination = (destination: MockDestination): string =>
  destination.path.length === 0
    ? destination.title
    : `${destination.path.join(' / ')} / ${destination.title}`;

import type { NoteResource } from '../../infrastructure/api/contracts';

/** A saved note as a card sees it. The card names only the container; the editor has the path. */
export const noteToResource = (note: MockNote): NoteResource => ({
  kind: 'note',
  id: String(note.id),
  title: note.title,
  summary: note.description,
  parent: { type: note.destination.type, id: note.destination.id },
  createdAt: '',
  location: note.destination.title,
});

/** A saved note as Home and the detail screen would see it: a server summary plus its body. */
export interface MockNote {
  readonly id: number;
  readonly revision: number;
  readonly title: string;
  /** The empty string when unset. Never a body excerpt. */
  readonly description: string;
  readonly body: string;
  readonly destination: MockDestination;
}

const at = (
  type: 'area' | 'project',
  id: number,
  title: string,
  path: readonly string[],
): MockDestination => ({ type, id, title, path });

export const MOCK_NOTES: readonly MockNote[] = [
  {
    id: 41,
    revision: 1,
    title: 'Type scale for the portfolio',
    description: 'Sora for headings, Source Sans for everything else',
    body: 'Headings at 40, 28, 22. Body at 17 on a 26 line.\n\nKeep the wordmark lowercase. It reads calmer next to the emblems.',
    destination: at('project', 101, 'Portfolio site', ['Creative work', 'Design']),
  },
  {
    id: 38,
    revision: 1,
    title: 'Why attention drifts after lunch',
    description: '',
    body: 'Three candidate causes, none of them convincing on their own:\n\n- glucose\n- the room warming up\n- the meeting that follows lunch\n\nWorth reading the Huberman episode again before writing this up.',
    destination: at('project', 102, 'Essay on attention', ['Creative work', 'Writing']),
  },
  {
    id: 36,
    revision: 1,
    title: 'Tile samples',
    description: 'What came back from the showroom',
    body: 'Zellige in bone and sage. The sage is greener in daylight than the photo suggested.\n\nSecond visit Thursday.',
    destination: at('project', 103, 'Kitchen reno', ['Home life']),
  },
  {
    id: 29,
    revision: 1,
    title: 'Ownership, chapter 4',
    description: 'Moves, borrows, and the one rule I keep forgetting',
    body: 'A value has exactly one owner. A borrow does not move it.\n\n```rust\nlet s = String::from("hi");\nlet t = &s;\n```\n\nThe thing I keep forgetting: a mutable borrow excludes every other borrow, not just other mutable ones.',
    destination: at('project', 104, 'Rust book', ['Learning']),
  },
  {
    id: 22,
    revision: 1,
    title: 'Interview prep',
    description: '',
    body: 'Stories to have ready: the migration, the outage, the hire that did not work out.',
    destination: at('area', 6, 'Notes', ['Learning']),
  },
];

/** Why a note is unfinished: never saved, sent without an answer, or refused by the server. */
export type MockUnfinishedKind = 'draft' | 'unconfirmed' | 'refused';

/** A note kept on this phone that has no confirmed copy on the server. */
export interface MockDraft {
  readonly id: number;
  readonly kind: MockUnfinishedKind;
  /** The empty string for a draft nobody titled. */
  readonly title: string;
  readonly description: string;
  readonly body: string;
  readonly destination: MockDestination | null;
  /** When it was last touched, already worded: "Edited 2 h ago". */
  readonly when: string;
  /** The server's reason, for a refused save. */
  readonly reason?: string;
  /** Set when the draft belongs to a server this phone is no longer connected to. */
  readonly endpoint?: string;
}

export const MOCK_DRAFTS: readonly MockDraft[] = [
  {
    id: 901,
    kind: 'unconfirmed',
    title: 'Grout colour for the zellige',
    description: '',
    body: 'Charcoal grout turns the bone tiles into a grid. Off-white lets the edges wander, which is the point of handmade tile.\n\nGoing with off-white unless the sample says otherwise.',
    destination: at('project', 103, 'Kitchen reno', ['Home life']),
    when: 'Sent 12 min ago',
  },
  {
    id: 902,
    kind: 'draft',
    title: '',
    description: '',
    body: 'The borrow checker is a linter with opinions about time. Most of the fights are about lifetimes I have not written down yet.',
    destination: null,
    when: 'Edited 2 h ago',
  },
  {
    id: 903,
    kind: 'draft',
    title: 'Things to ask the electrician',
    description: 'Before the island goes in',
    body: '- Is the island circuit its own breaker?\n- Under-cabinet lights on the same switch as the pendants?\n- Where does the dishwasher plug live?',
    destination: at('project', 103, 'Kitchen reno', ['Home life']),
    when: 'Edited yesterday',
  },
  {
    id: 904,
    kind: 'refused',
    title:
      'A note whose title ran on far past the point where anyone would read it, about attention and lunch and the meeting after lunch and the room and the way the afternoon goes when the thing you meant to do is still the thing you meant to do',
    description: '',
    body: 'The title needs cutting. The body is fine.',
    destination: at('project', 102, 'Essay on attention', ['Creative work', 'Writing']),
    when: 'Refused 3 h ago',
    reason: 'The title is longer than 200 characters.',
  },
  {
    id: 905,
    kind: 'unconfirmed',
    title: 'Backup strategy for the NAS',
    description: '',
    body: 'Two copies, one off-site. The off-site one is the problem.',
    destination: at('area', 4, 'Home life', []),
    when: 'Sent 3 days ago',
    endpoint: 'raphael.old-flat.home',
  },
  {
    id: 906,
    kind: 'draft',
    title: 'Names for the cat',
    description: '',
    body: 'Miso. Pixel. Ada. Not Whiskers.',
    destination: null,
    when: 'Edited last week',
    endpoint: 'raphael.old-flat.home',
  },
];
