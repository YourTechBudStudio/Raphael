# Organize

- **Move**: an item keeps its id, and everything inside moves with it. Into an existing area or project it keeps its slug; otherwise the destination's last segment becomes the new slug. Notes go into areas or projects, projects into areas, areas into areas or the root.
- **Archive instead of delete**: there is no delete. Archive finished projects, responsibilities the user has given up, and superseded notes. Archiving hides the item and everything inside it from lists and search, and can be undone.
- **Finish a project**: archive it, after offering to move notes that stay useful into the area they serve, since archiving hides them too. A paused project is marked `--inactive` instead ([Change](change.md)).
- **Restore**: it removes only the item's own archive cause. When a container keeps the item archived, the result names it; restore the container, or move the item to an active parent if only the item should come back.
- **Reorganize several items**: list the tree with `-r --include-archived`, following `page.hasMore` until the listing is complete, because archived items are hidden by default yet still hold their slugs. Describe the target structure to the user, and move once they agree.

Tell the user each path that changed (`previousPath` to `path` in JSON).

## Commands

```sh
raphael list /work -r --include-archived --json
raphael move /work/client-x/launch-moves-to-march /work/client-x/website-launch --json
raphael archive /work/client-x/website-launch --json
raphael restore /work/client-x/website-launch --json
raphael favorite /work/client-x --json
```

Details: `raphael help move`, `raphael help archive`, `raphael help restore`.
