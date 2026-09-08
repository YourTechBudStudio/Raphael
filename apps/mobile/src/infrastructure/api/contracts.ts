/** Shared backend-boundary data contracts. Currently implemented by the in-memory adapter. */

export type CollectionType = 'area' | 'project';

/** Reference to the collection a resource lives in. */
export interface ParentRef {
  type: CollectionType;
  id: string;
}

/** Reference to a favorited collection. */
export type FavoriteRef = ParentRef;

/** Where a capture flow writes to. 'home' means the default inbox area. */
export type CaptureTarget = ParentRef | { type: 'home'; id?: undefined };

export type AreaEmblem = 'layers';
export type ProjectEmblem = 'petals' | 'arch';

export interface Area {
  id: string;
  name: string;
  description: string;
  parentAreaId: string | null;
  emblem: AreaEmblem;
}

export interface Project {
  id: string;
  name: string;
  description: string;
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
