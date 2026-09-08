import type { Area, FavoriteRef, Project, Resource } from '../api/contracts';
import { mockImages } from './images';

/** Capture target for Home: notes without a chosen home land here. */
export const INBOX_AREA_ID = 'inbox';

export const areas: Area[] = [
  {
    id: INBOX_AREA_ID,
    name: 'Inbox',
    description: 'Things that have not found a home yet.',
    parentAreaId: null,
    emblem: 'layers',
  },
  {
    id: 'creative-work',
    name: 'Creative work',
    description: 'A home for things I make and learn.',
    parentAreaId: null,
    emblem: 'layers',
  },
  {
    id: 'design',
    name: 'Design',
    description: 'Shape how things look, feel, and move.',
    parentAreaId: 'creative-work',
    emblem: 'layers',
  },
  {
    id: 'writing',
    name: 'Writing',
    description: 'Words that explain and persuade.',
    parentAreaId: 'creative-work',
    emblem: 'layers',
  },
  {
    id: 'personal',
    name: 'Personal',
    description: 'Life outside work.',
    parentAreaId: null,
    emblem: 'layers',
  },
  {
    id: 'learning',
    name: 'Learning',
    description: 'Things I am figuring out.',
    parentAreaId: null,
    emblem: 'layers',
  },
];

export const projects: Project[] = [
  {
    id: 'raphael',
    name: 'Raphael',
    description: 'Build a calmer second brain.',
    areaId: 'creative-work',
    emblem: 'petals',
  },
  {
    id: 'portfolio',
    name: 'Portfolio',
    description: 'Show the work that matters.',
    areaId: 'creative-work',
    emblem: 'arch',
  },
  {
    id: 'interface-studies',
    name: 'Interface studies',
    description: 'Explore layouts and interactions.',
    areaId: 'design',
    emblem: 'petals',
  },
  {
    id: 'icon-library',
    name: 'Icon library',
    description: 'Collect and refine visual language.',
    areaId: 'design',
    emblem: 'arch',
  },
  {
    id: 'japan-trip',
    name: 'Japan trip',
    description: 'Two weeks in spring.',
    areaId: 'personal',
    emblem: 'arch',
  },
  {
    id: 'effect-notes',
    name: 'Effect notes',
    description: 'Learn the primitives properly.',
    areaId: 'learning',
    emblem: 'petals',
  },
];

/** Deliberate priorities, independent from quick-access favorites. No expiry or count limit. */
export const activeProjectIds: string[] = ['raphael', 'interface-studies', 'japan-trip'];

export const favorites: FavoriteRef[] = [
  { type: 'project', id: 'raphael' },
  { type: 'project', id: 'japan-trip' },
];

const wavePatterns: number[][] = [
  [
    0.22, 0.38, 0.55, 0.42, 0.68, 0.84, 0.61, 0.47, 0.73, 0.9, 0.66, 0.5, 0.35, 0.58, 0.79, 0.94,
    0.71, 0.53, 0.4, 0.62, 0.86, 0.7, 0.48, 0.33, 0.57, 0.45, 0.3, 0.2,
  ],
  [
    0.3, 0.52, 0.71, 0.58, 0.4, 0.66, 0.88, 0.74, 0.5, 0.36, 0.61, 0.83, 0.95, 0.69, 0.45, 0.32,
    0.54, 0.77, 0.9, 0.63, 0.44, 0.28, 0.49, 0.72, 0.6, 0.41, 0.27, 0.18,
  ],
  [
    0.18, 0.34, 0.6, 0.82, 0.64, 0.43, 0.29, 0.51, 0.75, 0.92, 0.7, 0.46, 0.31, 0.56, 0.8, 0.66,
    0.48, 0.37, 0.59, 0.85, 0.68, 0.42, 0.26, 0.47, 0.73, 0.55, 0.34, 0.21,
  ],
  [
    0.26, 0.45, 0.67, 0.89, 0.72, 0.5, 0.33, 0.58, 0.81, 0.62, 0.41, 0.28, 0.53, 0.76, 0.93, 0.65,
    0.44, 0.3, 0.55, 0.78, 0.6, 0.39, 0.24, 0.46, 0.7, 0.52, 0.35, 0.19,
  ],
];

/** Deterministic waveform for a fixture voice note. */
export function waveformFor(index: number): number[] {
  const pattern = wavePatterns[index % wavePatterns.length];

  return pattern === undefined ? [] : [...pattern];
}

export const resources: Resource[] = [
  // Home feed, newest first.
  {
    id: 'walking-thoughts',
    kind: 'voice',
    title: 'Walking thoughts',
    summary: 'Make room for unfinished ideas.',
    parent: { type: 'project', id: 'raphael' },
    createdAt: '2026-03-14T09:20:00.000Z',
    durationSeconds: 42,
    waveform: waveformFor(0),
  },
  {
    id: 'quiet-spaces',
    kind: 'image',
    title: 'Quiet spaces',
    summary: 'Light, texture, and room to think.',
    parent: { type: 'project', id: 'raphael' },
    createdAt: '2026-03-13T18:05:00.000Z',
    image: mockImages['quiet-spaces'],
  },
  {
    id: 'a-small-thought',
    kind: 'note',
    title: 'A small thought',
    summary: 'Keep the idea. Decide where it belongs later.',
    parent: { type: 'area', id: 'personal' },
    createdAt: '2026-03-12T21:40:00.000Z',
  },
  {
    id: 'maggie-garden',
    kind: 'github',
    title: 'maggie / garden',
    summary: 'A tiny tool for connected notes.',
    parent: { type: 'area', id: 'learning' },
    createdAt: '2026-03-11T08:15:00.000Z',
  },

  // Creative work, direct resources.
  {
    id: 'visual-references',
    kind: 'image',
    title: 'Visual references',
    summary: 'Forms, colors, and quiet details.',
    parent: { type: 'area', id: 'creative-work' },
    createdAt: '2026-03-10T16:30:00.000Z',
    image: mockImages['visual-references'],
  },
  {
    id: 'working-principles',
    kind: 'note',
    title: 'Working principles',
    summary: 'Make useful things. Leave room to explore.',
    parent: { type: 'area', id: 'creative-work' },
    createdAt: '2026-03-09T11:05:00.000Z',
  },
  {
    id: 'a-thought-on-craft',
    kind: 'voice',
    title: 'A thought on craft',
    summary: 'Small details change how a tool feels.',
    parent: { type: 'area', id: 'creative-work' },
    createdAt: '2026-03-08T19:45:00.000Z',
    durationSeconds: 36,
    waveform: waveformFor(1),
  },

  // Design, direct resources.
  {
    id: 'design-principles',
    kind: 'note',
    title: 'Design principles',
    summary: 'Rounded cards. Waves within. Motion that flows.',
    parent: { type: 'area', id: 'design' },
    createdAt: '2026-03-07T14:10:00.000Z',
  },
  {
    id: 'shape-references',
    kind: 'image',
    title: 'Shape references',
    summary: 'Soft corners and continuous curves.',
    parent: { type: 'area', id: 'design' },
    createdAt: '2026-03-06T10:25:00.000Z',
    image: mockImages['shape-references'],
  },
  {
    id: 'a-thought-on-motion',
    kind: 'voice',
    title: 'A thought on motion',
    summary: 'Let each action flow into the next.',
    parent: { type: 'area', id: 'design' },
    createdAt: '2026-03-05T09:00:00.000Z',
    durationSeconds: 28,
    waveform: waveformFor(2),
  },

  // Raphael project.
  {
    id: 'design-direction',
    kind: 'note',
    title: 'Design direction',
    summary: 'Rounded cards. Waves within. Motion that flows.',
    parent: { type: 'project', id: 'raphael' },
    createdAt: '2026-03-04T17:35:00.000Z',
  },
  {
    id: 'capture-should-flow',
    kind: 'voice',
    title: 'Capture should flow',
    summary: 'Let the button become the note.',
    parent: { type: 'project', id: 'raphael' },
    createdAt: '2026-03-03T12:50:00.000Z',
    durationSeconds: 42,
    waveform: waveformFor(3),
  },
  {
    id: 'raphael-mobile',
    kind: 'github',
    title: 'raphael / mobile',
    summary: 'The home for the mobile app.',
    parent: { type: 'project', id: 'raphael' },
    createdAt: '2026-03-02T08:40:00.000Z',
  },

  // Writing.
  {
    id: 'plain-words',
    kind: 'note',
    title: 'Plain words',
    summary: 'Say the thing, then stop.',
    parent: { type: 'area', id: 'writing' },
    createdAt: '2026-03-01T15:20:00.000Z',
  },
  {
    id: 'a-thought-on-drafts',
    kind: 'voice',
    title: 'A thought on drafts',
    summary: 'The first version is only a starting point.',
    parent: { type: 'area', id: 'writing' },
    createdAt: '2026-02-28T13:05:00.000Z',
    durationSeconds: 31,
    waveform: waveformFor(0),
  },

  // Personal.
  {
    id: 'slow-weekends',
    kind: 'note',
    title: 'Slow weekends',
    summary: 'Leave a day with nothing planned.',
    parent: { type: 'area', id: 'personal' },
    createdAt: '2026-02-27T10:15:00.000Z',
  },

  // Learning.
  {
    id: 'what-a-fiber-is',
    kind: 'note',
    title: 'What a fiber is',
    summary: 'A description of work, not the work itself.',
    parent: { type: 'area', id: 'learning' },
    createdAt: '2026-02-26T18:30:00.000Z',
  },

  // Portfolio.
  {
    id: 'case-study-outline',
    kind: 'note',
    title: 'Case study outline',
    summary: 'Problem, choices, result. Nothing else.',
    parent: { type: 'project', id: 'portfolio' },
    createdAt: '2026-02-25T09:45:00.000Z',
  },
  {
    id: 'a-thought-on-selection',
    kind: 'voice',
    title: 'A thought on selection',
    summary: 'Show fewer projects, explain them better.',
    parent: { type: 'project', id: 'portfolio' },
    createdAt: '2026-02-24T16:00:00.000Z',
    durationSeconds: 25,
    waveform: waveformFor(1),
  },

  // Japan trip.
  {
    id: 'quiet-light',
    kind: 'image',
    title: 'Quiet light',
    summary: 'Morning in a narrow street.',
    parent: { type: 'project', id: 'japan-trip' },
    createdAt: '2026-02-23T07:20:00.000Z',
    image: mockImages['quiet-light'],
  },
  {
    id: 'trains-and-timing',
    kind: 'note',
    title: 'Trains and timing',
    summary: 'Book the long legs early. Improvise the rest.',
    parent: { type: 'project', id: 'japan-trip' },
    createdAt: '2026-02-22T12:10:00.000Z',
  },

  // Interface studies.
  {
    id: 'list-density',
    kind: 'note',
    title: 'List density',
    summary: 'Fewer rows, more room to read.',
    parent: { type: 'project', id: 'interface-studies' },
    createdAt: '2026-02-21T11:35:00.000Z',
  },
  {
    id: 'a-thought-on-sheets',
    kind: 'voice',
    title: 'A thought on sheets',
    summary: 'A sheet should feel like it came from somewhere.',
    parent: { type: 'project', id: 'interface-studies' },
    createdAt: '2026-02-20T14:55:00.000Z',
    durationSeconds: 29,
    waveform: waveformFor(2),
  },

  // Icon library.
  {
    id: 'stroke-weights',
    kind: 'note',
    title: 'Stroke weights',
    summary: 'One weight everywhere, or it reads as noise.',
    parent: { type: 'project', id: 'icon-library' },
    createdAt: '2026-02-19T10:05:00.000Z',
  },
  {
    id: 'lucide-icons',
    kind: 'github',
    title: 'lucide / lucide',
    summary: 'The icon set the app draws from.',
    parent: { type: 'project', id: 'icon-library' },
    createdAt: '2026-02-18T09:30:00.000Z',
  },

  // Effect notes.
  {
    id: 'layers-and-services',
    kind: 'note',
    title: 'Layers and services',
    summary: 'Wire dependencies once, at the edge.',
    parent: { type: 'project', id: 'effect-notes' },
    createdAt: '2026-02-17T20:15:00.000Z',
  },
  {
    id: 'a-thought-on-retries',
    kind: 'voice',
    title: 'A thought on retries',
    summary: 'Retry the flaky part, not the whole request.',
    parent: { type: 'project', id: 'effect-notes' },
    createdAt: '2026-02-16T17:40:00.000Z',
    durationSeconds: 33,
    waveform: waveformFor(3),
  },
];
