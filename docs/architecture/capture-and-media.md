# Capture and media

This describes ownership and persistence boundaries, not a screen flow or upload protocol.

## Drafts and placement

Text and voice capture converge on an editable note preview; voice adds transcription before editing. The mobile app persists unsaved content, recordings, and placement choices on-device across restarts. There are no server-side draft notes. Transcription failure leaves the recording available for retry.

Core offers agent-backed parent recommendations separately from creation. The user can select or override an area/project; recommendations never silently replace a manual choice. Save requires a destination, with manual selection or container creation available when recommendations fail or find no match. There is no default inbox.

Explicit Save creates the note through ordinary core operations. Creating an area/project during capture commits independently and survives discarding the note. The stored resource is a note regardless of its capture method.

## Unsent writing

Mobile requires a reachable server. Drafts and edits the server has not accepted stay on-device and are retried automatically; those that need the person, such as refusals and revision conflicts, appear in Unfinished, where a conflict is resolved by keeping either version.

## Attachments

A note's attachments are file resources that live in the note, as defined in [ADR 0008](../adrs/0008-file-resources-and-stored-bytes.md). Files can also live directly in areas and projects. Upload and node creation are separate persistence steps, so retrying a note mutation need not resend its files. Adding and removing attachments is atomic with the rest of a note's create or update and advances the note's revision. Removing an attachment archives its file.

Draft attachments remain on-device until Save succeeds. A saved note's edits autosave, so attaching to it uploads right away. Uploads that are never linked are collected after a bounded grace period; this does not limit local draft lifetime, and the device re-uploads from its originals when a collected upload is rejected. Save must not claim a collected upload as successfully linked.

File identity is independent of its original filename. Preserve filename and media type so downloaded content remains usable; entity retrieval supplies file metadata, while content is downloaded separately. Clients open downloaded files with the platform's own handling rather than an in-app viewer, and edits made elsewhere do not sync back.

Sharing files to Raphael from another app opens a new capture draft with those files attached. It does not save a note.
