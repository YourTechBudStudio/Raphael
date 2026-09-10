# Organization and context

Raphael distinguishes the structure of work from the material that helps people and agents understand it. The following describes intended product behavior.

## Three entity types

| Entity   | Meaning                                                                    | Organization                                           |
| -------- | -------------------------------------------------------------------------- | ------------------------------------------------------ |
| Area     | An ongoing responsibility, generally without a due date                    | Can contain subareas, projects, and resources          |
| Project  | A bounded outcome spanning days, weeks, or months, usually with a due date | Belongs to one area and can contain resources          |
| Resource | A piece of content or an external reference, with an extensible kind       | Has exactly one immediate parent: an area or a project |

Areas and projects are not resource kinds. A note is the default resource kind, supplied by a built-in extension; integrations can introduce others, such as GitHub issues or repositories. Resource kinds can influence presentation without changing where the resource belongs.

## One home, broader views

Opening an area exposes its organizational structure and resources. A view can also include resources from descendant areas and projects without moving or duplicating those resources. Their immediate parent remains their home.

Direct and nested content should be distinguishable. Whether nested resources appear by default, and how groups and filters are presented, remains a UI decision.

## Stored content and external references

A resource can contain Raphael-owned material, such as a text note or voice recording. It can also represent something managed elsewhere, carrying a kind, link, and whatever context the integration stores. Some integrations may copy external content; others may store only a reference.

Retrieving a resource returns its stored representation, not an automatic live fetch from the external system. An agent can use the reference to retrieve additional material through the appropriate external tool.

Scoped search finds registered work and its context, including external matches where integrations support them. Results distinguish incomplete coverage from no matches; a stored link alone does not make its entire external document searchable. See [Retrieval and search authority](../adrs/0001-retrieval-and-search-authority.md).

## Example: Offline Capture

A possible GitHub integration recognizes a labeled issue and creates a corresponding project under the Raphael area. The person then captures their own ideas within that project.

```text
Raphael — area
├── Raphael repository — GitHub repository resource
├── Product direction — note resource
└── Offline Capture — project linked to a GitHub issue
    ├── Capture constraints — note resource
    └── An idea recorded on a walk — note resource with voice attachment
```

When working on Offline Capture, an agent can find the project, follow its issue reference, and retrieve the local notes. Searching or viewing the broader Raphael area can include those notes as nested context while preserving their project membership.

The label mapping is illustrative, not a required GitHub policy or a rule for every integration. The same organizational model also supports manually created projects and work managed outside coding tools.

## Archive and recovery

Raphael archives rather than deletes. Archiving an area or project archives its descendants while retaining their data and relationships.

Restoring a container does not revive independently archived content. Material archived only through its container can be moved into an active location without restoring the whole container. See [Archive and restore authority](../adrs/0003-archive-and-restore-authority.md) for the cause model.
