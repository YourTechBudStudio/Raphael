/**
 * The shapes that cross this app's backend boundary.
 *
 * Two different things live behind that boundary now, and the split is deliberate. Areas and
 * projects are **server data**: they come from `@raphael/client` against the connected Raphael,
 * they have numeric identities the server minted, and this file does not redeclare their shape -
 * `@raphael/contracts/nodes` already owns it, and a second declaration here would be a second
 * authority that could drift.
 *
 * Notes, favorites, and active-project selections are **session-only local data**. There is no
 * server operation for any of them in this release. What is declared here is their shape, and the
 * one rule that keeps them honest: they hold a `ContainerRef` - a numeric reference to a real
 * container - and never a copy of a container's title, description, or parent. A local record that
 * copied server fields would be a second hierarchy that goes stale silently.
 */

import type { NodeType } from '@raphael/contracts/nodes';

/** Areas and projects. The server's own vocabulary, not a parallel one. */
export type ContainerType = NodeType;

/**
 * A reference to a container that exists on the server.
 *
 * The id is the server's numeric id. Nothing local stores anything else about the container it
 * points at, so a rename on the server is visible immediately and a local record can never
 * disagree with the hierarchy about what something is called.
 */
export interface ContainerRef {
  type: ContainerType;
  id: number;
}

export type ResourceKind = 'note' | 'voice' | 'image' | 'github';

interface ResourceBase {
  id: string;
  title: string;
  summary: string;
  /** The container this was captured into. Always an area or project the server knows about. */
  parent: ContainerRef;
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
