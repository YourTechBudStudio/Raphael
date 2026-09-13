/** Shared backend-boundary data contracts. Currently implemented by the in-memory adapter. */

export type CollectionType = 'area' | 'project';

/** Reference to the collection a resource lives in. */
export interface ParentRef {
  type: CollectionType;
  id: string;
}

/** Reference to a favorited collection. */
export type FavoriteRef = ParentRef;

/**
 * What a container creation makes and where. The root holds only areas, so `parentAreaId` is
 * null exactly when `type` is `area` and the new area will sit at the top of the tree.
 */
export interface ContainerTarget {
  type: CollectionType;
  parentAreaId: string | null;
}

/**
 * One creation request. The key identifies the logical attempt across retries, and the three
 * authored fields are what that attempt says: only the title is required, and the other two are
 * the empty string when they were left alone.
 */
export interface CreateContainerInput extends ContainerTarget {
  title: string;
  description: string;
  /** Markdown source, as written. */
  body: string;
  attemptKey: string;
}

/**
 * What a creation request came back with. `uncertain` is the answer when the request left the
 * phone but no answer arrived: the container may or may not exist, and only a check by key
 * can say. It is never a failure the sheet may quietly retry as if nothing had been sent.
 */
export type CreateContainerOutcome =
  | { kind: 'created'; collection: Collection }
  | {
      kind: 'rejected';
      reason: 'collision' | 'title_unusable' | 'parent_missing' | 'other';
      message: string;
    }
  | { kind: 'uncertain' };

/** What the server says about an earlier attempt when asked by its key. */
export type AttemptCheck =
  | { kind: 'created'; collection: Collection }
  | { kind: 'not_created' }
  | { kind: 'expired' };

/**
 * An attempt whose outcome is unknown, kept so it can be resolved later rather than repeated.
 * It carries the whole payload, unchanged, because resolving it means asking about or resending
 * exactly what was sent, not something reassembled from what is on screen now.
 */
export interface PendingAttempt extends ContainerTarget {
  attemptKey: string;
  title: string;
  description: string;
  body: string;
}

/** Where a capture flow writes to. 'home' means the default inbox area. */
export type CaptureTarget = ParentRef | { type: 'home'; id?: undefined };

export type AreaEmblem = 'layers';
export type ProjectEmblem = 'petals' | 'arch';

export interface Area {
  id: string;
  name: string;
  description: string;
  /** The saved body as Markdown source, shown read-only. Empty when nothing has been written. */
  body: string;
  parentAreaId: string | null;
  emblem: AreaEmblem;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  /** The saved body as Markdown source, shown read-only. Empty when nothing has been written. */
  body: string;
  areaId: string;
  emblem: ProjectEmblem;
}

export type Collection = ({ type: 'area' } & Area) | ({ type: 'project' } & Project);

export type ResourceKind = 'note' | 'voice' | 'image' | 'github';

interface ResourceBase {
  id: string;
  title: string;
  summary: string;
  parent: ParentRef;
  createdAt: string;
}

export interface NoteResource extends ResourceBase {
  kind: 'note';
}

export interface VoiceResource extends ResourceBase {
  kind: 'voice';
  durationSeconds: number;
  /** 24 to 32 amplitudes in 0..1. */
  waveform: number[];
}

export interface ImageResource extends ResourceBase {
  kind: 'image';
  image: string;
}

export interface GithubResource extends ResourceBase {
  kind: 'github';
}

export type Resource = NoteResource | VoiceResource | ImageResource | GithubResource;

/** A node of the Browse tree: an area with its subareas and projects, or a project leaf. */
export interface BrowseNode {
  type: CollectionType;
  id: string;
  name: string;
  emblem: AreaEmblem | ProjectEmblem;
  children: BrowseNode[];
}

/** One step of a location path, ordered from the root ancestor to the target. */
export interface LocationStep {
  type: CollectionType;
  id: string;
  name: string;
}

/** Contents of an area screen. */
export interface AreaContents {
  subareas: Area[];
  projects: Project[];
  resources: Resource[];
}

/** Contents of a project screen. */
export interface ProjectContents {
  resources: Resource[];
}

/** Search results, grouped the way the search screen renders them. */
export interface SearchResults {
  collections: Collection[];
  resources: Resource[];
}

/** Search scope: everything, or inside one collection subtree. */
export type SearchScope = ParentRef | null;
