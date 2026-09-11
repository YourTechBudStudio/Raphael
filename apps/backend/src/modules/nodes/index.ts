/**
 * The hierarchy capability. This phase establishes storage only: the table declarations below are the
 * capability's contribution to the schema. Operations arrive in phase 04 and will be exported here,
 * keeping selectors, SQL, and replay details private behind this boundary.
 */
export { MAX_SAFE_DB_INTEGER, creationReplays, nodes } from './schema.ts';
