# ADR 0008: File resources and stored bytes

## Status

Accepted as architectural direction; implementation is not implied.

## Context

People keep reference files such as images, documents, and PDFs alongside their notes and want to open them with whatever their device uses for that type. An earlier direction treated these as attachments: a separate concept owned by an entity, linked through its own relationship, with temporary uploads, grace periods, and an object store. That made files a second kind of thing with its own identity, ownership, addressing, and lifecycle rules beside the node hierarchy.

Files placed directly in areas and projects, and a possible future file tree or mounted filesystem view, would need the same identity, placement, archive, and search behavior that nodes already have.

## Decision

A file is a resource of kind `file`, stored in the shared `nodes` table like every other entity ([ADR 0007](./0007-shared-node-storage.md)). It has ordinary identity, parent, sibling-unique slug, title, description, body, tags, metadata, revision, and lifecycle. Its title defaults to the original file name and may be changed independently. Its body is normally empty.

A file may live in an area, a project, or a note. Notes are the only resources that may contain children, and they may contain only files. Files contain nothing. A note's attachments are its file children, so attachment ownership is the ordinary parent relationship, and moving or archiving a note carries its files through the ordinary hierarchy and archive rules ([ADR 0003](./0003-archive-and-restore-authority.md)).

Core owns the stored bytes through a specialized `files` table rather than node metadata. It records each stored object's opaque storage key, original file name, media type, and size. Those facts are set at upload and are not editable through node updates, because opaque metadata belongs to extensions and editing it must never make content unreachable. A row without a node is an upload not yet linked; a row with a node is that file node's content, with at most one row per node.

Storage keys are random identifiers, never paths. Tree or mounted views are computed from the hierarchy and file names, so moves and renames never rewrite stored objects. A file node's slug is derived from its file name, and slugs accept periods as separators, so file slugs read like file names.

Uploading bytes and creating nodes are separate steps. A client uploads first and receives an upload ID, then creates or updates nodes that reference those IDs. Creating a note with attachments, or adding and removing attachments during a note update, is one atomic operation that creates file nodes, claims their uploads, archives removed files, and advances the note's revision. Claiming an upload succeeds only when the row is still unlinked, so a successful save can never reference collected content.

Storage is pluggable. Local disk is the default and an S3-compatible bucket is selectable in server configuration. Attachments are always available.

Background collection is the only process that deletes stored bytes. It deletes uploads that were never linked once a bounded grace period has passed, marking a row before deleting its object so interrupted deletions are retried. Removing an attachment archives its file node; archived files retain their bytes, and nodes are never hard-deleted.

## Consequences

- Files reuse node addressing, search over common fields, placement, move, and archive rules instead of a parallel ownership model. File contents are not searched.
- The only exception to "resources cannot contain children" is notes containing files. Views that include descendant resources must distinguish a note's files from resources placed directly in a container.
- Distinct derived slugs imply distinct file names within a parent, so a future tree or mount can show original names without collisions while a file keeps its derived slug.
- Switching storage backends does not migrate existing content.
- Clients keep local originals until a save succeeds and re-upload when an unlinked upload has been collected; a temporary upload is not promised to outlive an arbitrarily old draft.
- Upload size limits, retry protocols, and grace-period values are implementation choices, not part of this decision.

See [Capture and media](../architecture/capture-and-media.md) for the client persistence boundary and [Entities and relationships](../architecture/entities-and-relationships.md) for the hierarchy.
