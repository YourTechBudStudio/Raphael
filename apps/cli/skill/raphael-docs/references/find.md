# Find

Use this when the user asks what they have on something, and before planning or doing work that their stored context would inform.

- Search the most likely area or project first, then widen to `/` when that comes back empty. Search is recursive and matches titles, descriptions and note text. It has no stemming, so pass word variants and synonyms as repeated `-q` values, which are ORed: `-q token -q tokens -q credential`.
- List to see structure: `list <path>` shows direct children, `-r` shows everything below, and `--order-by updatedAt:desc` surfaces recent work. Filter by type or tags with `--filter`.
- Read an item with `get` before relying on its content or changing it. It returns the body, tags, metadata and current revision.
- Keep the id of anything you will come back to. Paths change when an item or a parent moves or is renamed; ids do not.
- Archived items are left out by default. Add `--include-archived` when looking for finished or past work, or when a JSON result reports `page.archivedLeftOut: true`.
- Fetch the next page (`page.hasMore`, `page.nextSkip`) when the answer could be beyond the first.
- A note that references something external holds only what was stored. Follow its link with the appropriate tool when you need the current version.

Cite the paths of what you found when you answer.

## Commands

```sh
raphael search /work/client-x -q 'launch date' -q deadline --json
raphael list /work -r --filter '{"type":"project"}' --order-by updatedAt:desc --json
raphael get /work/client-x/kickoff-notes --json
raphael path --id 42 --json
```

Details: `raphael help search`, `raphael help list`, `raphael help output`.
