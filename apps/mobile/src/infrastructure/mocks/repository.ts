import type {
  Area,
  AreaContents,
  BrowseNode,
  CaptureTarget,
  Collection,
  FavoriteRef,
  LocationStep,
  NoteResource,
  ParentRef,
  Project,
  ProjectContents,
  Resource,
  SearchResults,
  SearchScope,
  VoiceResource,
} from '../api/contracts';
import {
  areas as areaFixtures,
  favorites as favoriteFixtures,
  activeProjectIds as activeFixtures,
  INBOX_AREA_ID,
  projects as projectFixtures,
  resources as resourceFixtures,
} from './fixtures';

/** Simulated network latency, so loading states are real in the mock. */
const LATENCY_MS = 120;

/** How many recent resources the home feed shows. */
const HOME_FEED_SIZE = 4;

const delay = (ms: number = LATENCY_MS): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// Mutable mock database, seeded from the fixtures.
const db = {
  areas: [...areaFixtures],
  projects: [...projectFixtures],
  resources: [...resourceFixtures],
  favorites: [...favoriteFixtures],
  activeProjectIds: [...activeFixtures],
};

const byNewest = (a: Resource, b: Resource): number => b.createdAt.localeCompare(a.createdAt);

const sameRef = (a: ParentRef, b: ParentRef): boolean => a.type === b.type && a.id === b.id;

/** Areas are never shown in Browse, favorites, or search under the inbox id. */
const isInbox = (area: Area): boolean => area.id === INBOX_AREA_ID;

const findArea = (id: string): Area | undefined => db.areas.find((area) => area.id === id);

const findProject = (id: string): Project | undefined =>
  db.projects.find((project) => project.id === id);

const toCollection = (ref: ParentRef): Collection | undefined => {
  if (ref.type === 'area') {
    const area = findArea(ref.id);

    return area === undefined ? undefined : { type: 'area', ...area };
  }

  const project = findProject(ref.id);

  return project === undefined ? undefined : { type: 'project', ...project };
};

/** Resolves a capture target to the collection a new resource is written into. */
function resolveCaptureTarget(target: CaptureTarget): ParentRef {
  return target.type === 'home' ? { type: 'area', id: INBOX_AREA_ID } : target;
}

const resourcesIn = (parent: ParentRef): Resource[] =>
  db.resources.filter((resource) => sameRef(resource.parent, parent)).sort(byNewest);

const subareasOf = (areaId: string): Area[] =>
  db.areas.filter((area) => area.parentAreaId === areaId);

const projectsOf = (areaId: string): Project[] =>
  db.projects.filter((project) => project.areaId === areaId);

const buildNode = (collection: Collection): BrowseNode => {
  if (collection.type === 'project') {
    return {
      type: 'project',
      id: collection.id,
      name: collection.name,
      emblem: collection.emblem,
      children: [],
    };
  }

  return {
    type: 'area',
    id: collection.id,
    name: collection.name,
    emblem: collection.emblem,
    children: [
      ...subareasOf(collection.id).map((area) => buildNode({ type: 'area', ...area })),
      ...projectsOf(collection.id).map((project) => buildNode({ type: 'project', ...project })),
    ],
  };
};

/** All areas and projects contained in a collection, including the collection itself. */
const subtreeRefs = (root: ParentRef): ParentRef[] => {
  if (root.type === 'project') {
    return [root];
  }

  const refs: ParentRef[] = [root];

  for (const area of subareasOf(root.id)) {
    refs.push(...subtreeRefs({ type: 'area', id: area.id }));
  }

  for (const project of projectsOf(root.id)) {
    refs.push({ type: 'project', id: project.id });
  }

  return refs;
};

const matches = (haystack: string, needle: string): boolean =>
  haystack.toLowerCase().includes(needle);

export const repository = {
  /** Resolve the default inbox on the backend side, not in feature UI. */
  getCaptureLocationPath(target: CaptureTarget): Promise<LocationStep[]> {
    return repository.getLocationPath(resolveCaptureTarget(target));
  },

  /** The most recent resources across every collection, newest first. */
  async getHomeFeed(): Promise<Resource[]> {
    await delay();

    return [...db.resources].sort(byNewest).slice(0, HOME_FEED_SIZE);
  },

  async getArea(id: string): Promise<Area | null> {
    await delay();

    return findArea(id) ?? null;
  },

  async getAreaContents(id: string): Promise<AreaContents> {
    await delay();

    return {
      subareas: subareasOf(id),
      projects: projectsOf(id),
      resources: resourcesIn({ type: 'area', id }),
    };
  },

  async getProject(id: string): Promise<Project | null> {
    await delay();

    return findProject(id) ?? null;
  },

  async getProjectContents(id: string): Promise<ProjectContents> {
    await delay();

    return { resources: resourcesIn({ type: 'project', id }) };
  },

  /** Root areas with their subareas and projects nested underneath. */
  async getBrowseTree(): Promise<BrowseNode[]> {
    await delay();

    return db.areas
      .filter((area) => area.parentAreaId === null && !isInbox(area))
      .map((area) => buildNode({ type: 'area', ...area }));
  },

  /** Favorited areas and projects, in the order they were favorited. */
  async getFavorites(): Promise<Collection[]> {
    await delay();

    return db.favorites
      .map(toCollection)
      .filter((collection): collection is Collection => collection !== undefined);
  },

  /** Deliberately active projects in selection order, independent from favorites. */
  async getActiveProjects(): Promise<Project[]> {
    await delay();

    return db.activeProjectIds
      .map(findProject)
      .filter((project): project is Project => project !== undefined);
  },

  /** Explicit, idempotent selection: no expiry, automatic ranking, or count limit. */
  async setProjectActive(id: string, active: boolean): Promise<void> {
    await delay();

    if (findProject(id) === undefined) {
      throw new Error('This project is no longer available.');
    }

    if (active) {
      if (!db.activeProjectIds.includes(id)) {
        db.activeProjectIds = [...db.activeProjectIds, id];
      }
    } else {
      db.activeProjectIds = db.activeProjectIds.filter((projectId) => projectId !== id);
    }
  },

  /** The ancestor chain for a collection, from the root area down to the collection itself. */
  async getLocationPath(target: ParentRef): Promise<LocationStep[]> {
    await delay();

    const steps: LocationStep[] = [];
    let areaId: string | null = null;

    if (target.type === 'project') {
      const project = findProject(target.id);

      if (project === undefined) {
        return [];
      }

      steps.unshift({ type: 'project', id: project.id, name: project.name });
      areaId = project.areaId;
    } else {
      areaId = target.id;
    }

    while (areaId !== null) {
      const area: Area | undefined = findArea(areaId);

      if (area === undefined) {
        break;
      }

      steps.unshift({ type: 'area', id: area.id, name: area.name });
      areaId = area.parentAreaId;
    }

    return steps;
  },

  /** Case-insensitive match on names, titles, descriptions, and summaries. */
  async search(query: string, scope: SearchScope): Promise<SearchResults> {
    await delay();

    const needle = query.trim().toLowerCase();

    if (needle === '') {
      return { collections: [], resources: [] };
    }

    const scopeRefs = scope === null ? null : subtreeRefs(scope);
    const inScope = (ref: ParentRef): boolean =>
      scopeRefs === null || scopeRefs.some((candidate) => sameRef(candidate, ref));

    const collections: Collection[] = [
      ...db.areas
        .filter((area) => !isInbox(area))
        .map((area): Collection => ({ type: 'area', ...area })),
      ...db.projects.map((project): Collection => ({ type: 'project', ...project })),
    ].filter(
      (collection) =>
        inScope({ type: collection.type, id: collection.id }) &&
        (matches(collection.name, needle) || matches(collection.description, needle)),
    );

    const resources = db.resources
      .filter(
        (resource) =>
          inScope(resource.parent) &&
          (matches(resource.title, needle) || matches(resource.summary, needle)),
      )
      .sort(byNewest);

    return { collections, resources };
  },

  /** Adds or removes a favorite and returns the new favorite list. */
  async toggleFavorite(ref: FavoriteRef): Promise<Collection[]> {
    await delay();

    const existing = db.favorites.some((favorite) => sameRef(favorite, ref));

    db.favorites = existing
      ? db.favorites.filter((favorite) => !sameRef(favorite, ref))
      : [...db.favorites, ref];

    return db.favorites
      .map(toCollection)
      .filter((collection): collection is Collection => collection !== undefined);
  },

  /** Writes a text note into the capture target and returns it. */
  async createNote(target: CaptureTarget, title: string, body: string): Promise<NoteResource> {
    await delay();

    const parent = resolveCaptureTarget(target);
    const note: NoteResource = {
      id: `note-${String(db.resources.length + 1)}-${String(Date.now())}`,
      kind: 'note',
      title: title.trim() === '' ? 'Untitled note' : title.trim(),
      summary: body.trim(),
      parent,
      createdAt: new Date().toISOString(),
    };

    db.resources = [note, ...db.resources];

    return note;
  },

  /** Writes a voice note into the capture target and returns it. */
  async createVoiceNote(
    target: CaptureTarget,
    title: string,
    durationSeconds: number,
    waveform: number[],
  ): Promise<VoiceResource> {
    await delay();

    const parent = resolveCaptureTarget(target);
    const voice: VoiceResource = {
      id: `voice-${String(db.resources.length + 1)}-${String(Date.now())}`,
      kind: 'voice',
      title: title.trim() === '' ? 'Voice note' : title.trim(),
      summary: 'Recorded on this device.',
      parent,
      createdAt: new Date().toISOString(),
      durationSeconds,
      waveform: [...waveform],
    };

    db.resources = [voice, ...db.resources];

    return voice;
  },
};
