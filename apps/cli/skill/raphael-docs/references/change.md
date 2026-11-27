# Change

Locate the item ([Find](find.md)) and read it. When the change is built from what you read, such as an edited body or an extended tag list, send it with that read's `--revision` and address it by the read's `--id`. Without `--revision` the CLI pins the newest revision instead, so a value assembled from an older read silently erases a concurrent edit. Changes that do not depend on the old value, such as a new title or pausing a project, can leave the revision out.

- **Edit part of a body**: read and resend it as tiptap, changing only what was asked, as `raphael help content` describes. Editing the default Markdown export can alter content you were not asked to touch. Markdown is fine for a full rewrite the user asked for.
- **Tags**: `--tag` replaces the whole list, so to add one, send the tags you read plus the new one.
- **Slug**: `--slug` changes the item's path and every path inside it; a new title leaves paths alone.
- **Project state**: `--inactive` pauses a project and `--active` resumes it. A finished project is archived instead ([Organize](organize.md)).
- **Metadata**: it cannot be changed. When a metadata fact is wrong, tell the user; correcting it means creating a new item and archiving the old one, which needs their agreement.
- **Distill**: see [Method: distill](method.md#distill), editing the body as tiptap.

On a revision conflict (exit 4, `revision_conflict`), read the item again, apply your intended change to the new content, and retry with the new revision.

## Commands

```sh
raphael get --id 42 --json --return-format tiptap
raphael update --id 42 --revision 3 --body-format tiptap --body @- --json <<'EOF'
{"type":"doc","content":[...the edited document...]}
EOF
raphael update --id 42 --revision 3 --tag client-x --tag decisions --json
raphael update /work/client-x/website-launch --inactive --json
```

Tell the user what changed, including the old and new path when one moved. Details: `raphael help update`, `raphael help revisions`.
