# Capture

## Choose the home

- A finishable outcome is a project, an ongoing responsibility is an area, and content is a note in the area or project it serves most directly. The root holds only areas, and projects hold only notes.
- File into what exists. Create an area or project only when the user names a new responsibility or outcome; otherwise, when no home clearly fits, ask with a concrete suggested path. Raphael has no inbox to fall back on.
- Check for an existing note first (`raphael search <area> -q <words> --json`, syntax in [Find](find.md)); when one exists, extend it instead ([Change](change.md)).

[Method: placement](method.md#placement) covers harder choices.

## Shape the item

- **Title**: the point, not the category. A note without `--title` takes its title from the first line of its body.
- **Description**: a one- or two-sentence gist. Search matches titles, descriptions and note text, so anything the user will look for belongs in one of them.
- **Body**: the user's words as given, plus the context that makes them usable later: why it matters, where it came from, what it relates to. Pass `--strict` so a construct Raphael cannot store as written is refused instead of degraded, then rewrite it in a supported form, such as a table as a list.
- **Tags**: cross-cutting labels such as a client, person or theme, used with `--filter`. Reuse the spellings already on nearby items, because tags are case-sensitive.
- **Metadata**: structured facts that never change, such as source URL, author or publication date. It is set once at create, cannot be updated, and cannot be searched or filtered, so keep status and anything the user will look up out of it.
- **External material**: store the link with why it matters, and an excerpt or summary when the user will need it without opening the source.

The last path segment is the slug: lowercase words joined by single hyphens, usually derived from the title. A taken slug, including one held by an archived item, exits 4; choose another slug or restore the archived item.

## Commands

```sh
raphael create resource.note /work/client-x/launch-moves-to-march --description 'Kickoff moved the launch to March.' --tag client-x --metadata '{"source":"kickoff meeting"}' --strict --body @- --json <<'EOF'
# Launch moves to March
...
EOF
raphael create project /work/client-x/website-launch --title 'Website launch' --json
raphael create area /health --title Health --json
```

Send multi-line bodies through `--body @-` or `--body @file`; a value that starts with `-` must be joined to its flag, as in `--body='- first item'`. Tell the user the path of what you created. Details: `raphael help create`, `raphael help content`.
