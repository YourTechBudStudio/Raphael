/**
 * Transport-contract data: the method and path an operation is published at. Capabilities own their
 * own descriptors. This is deliberately inert data, not a route-registration or client-generation
 * mechanism; the HTTP host and the typed client each read it and do their own wiring.
 */
export interface RouteDescriptor {
  readonly method: 'POST';
  readonly path: string;
}
