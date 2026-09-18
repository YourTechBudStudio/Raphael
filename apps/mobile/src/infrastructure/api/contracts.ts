/**
 * The shapes that cross this app's backend boundary.
 *
 * Two different things live behind that boundary now, and the split is deliberate. Areas and
 * projects are **server data**: they come from `@raphael/client` against the connected Raphael,
 * they have numeric identities the server minted, and this file does not redeclare their shape -
 * `@raphael/contracts/nodes` already owns it, and a second declaration here would be a second
 * authority that could drift.
 *
 * Media captured in this session and favorites are **session-only local data**. There is no server
 * operation for either of them in this release. What is declared here is their shape, and the one
 * rule that keeps them honest: they hold a `ContainerRef` - a numeric reference to a real container
 * - and never a copy of a container's title, description, or parent. A local record that copied
 * server fields would be a second hierarchy that goes stale silently.
 *
 * Notes used to be here too, and so did the active-project selection. Both are server data now:
 * `@raphael/contracts/nodes` owns their shape, `modules/resources` reads the notes, and a project's
 * active status is a field on its own row that `modules/collections` reads and writes.
 */

import type { ContainerType } from '@raphael/contracts/nodes';

/**
 * Areas and projects. The server's own container vocabulary, not a parallel one.
 *
 * Deliberately `ContainerType` rather than `NodeType`. The server's node vocabulary now includes
 * `resource`, and everything below means "a container": a thing that can hold a capture, be a
 * destination, and appear in the hierarchy. Aliasing the wider type would have silently made every one
 * of those sites accept a note.
 */
export type { ContainerType };

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

/**
 * The kinds of session-only media this app still holds in memory.
 *
 * Not the server's `ResourceKind`, which shares the name and means something narrower: the kinds core
 * actually admits. These are presentation categories for media captured in this session and never
 * sent anywhere. Notes are gone from this union: a note is server data now, described by
 * `NodeSummary`, and `modules/resources` renders it from that shape rather than adapting it into
 * this one.
 */
export type ResourceKind = 'voice' | 'image' | 'github';

interface ResourceBase {
  id: string;
  title: string;
  summary: string;
  /** The container this was captured into. Always an area or project the server knows about. */
  parent: ContainerRef;
  createdAt: string;
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

export type Resource = VoiceResource | ImageResource | GithubResource;
