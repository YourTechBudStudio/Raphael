# Organization and context

Raphael distinguishes the structure of work from the material that helps people and agents understand it. The following describes intended product behavior.

## Three entity types

| Entity   | Meaning                                                                    | Organization                                           |
| -------- | -------------------------------------------------------------------------- | ------------------------------------------------------ |
| Area     | An ongoing responsibility, generally without a due date                    | Can contain subareas, projects, and resources          |
| Project  | A bounded outcome spanning days, weeks, or months, usually with a due date | Belongs to one area and can contain resources          |
| Resource | A piece of content or an external reference, with an extensible kind       | Has exactly one immediate parent: an area or a project |

Areas and projects are not resource kinds. A note is the default resource kind; integrations can introduce others, such as GitHub issues or repositories. Resource kinds can influence presentation without changing where the resource belongs.

## One home, broader views

Opening an area exposes its organizational structure and resources. A view can also include resources from descendant areas and projects without moving or duplicating those resources. Their immediate parent remains their home.

Direct and nested content should be distinguishable. Whether nested resources appear by default, and how groups and filters are presented, remains a UI decision.

## Stored content and external references

A resource can contain Raphael-owned material, such as a text note or voice recording. It can also represent something managed elsewhere, carrying a kind, link, and whatever context the integration stores. Some integrations may copy external content; others may store only a reference.

Retrieving a resource returns its stored representation, not an automatic live fetch from the external system. An agent can use the reference to retrieve additional material through the appropriate external tool.

Search is scoped to an area, project, or comparable context. It searches registered entities rather than discovering arbitrary external objects. Relevant integrations may implicitly contribute matches from external content associated with those entities; users do not need to issue separate provider-specific searches.

Search coverage depends on the integration. Copied content can be searched within Raphael; a reference-only resource without external search support makes its stored information searchable, not the external document's full contents. If a participating source fails, results should disclose that the search is incomplete.

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

Restoring it restores only content archived because of that action. An independently archived note remains archived. Likewise, if an integration independently archives a project while its area is archived, restoring the area does not reactivate that project or its contents.

Integration policy determines when external lifecycle events warrant an independent archive or restoration. Losing a label mapping or external association does not by itself require the local work and its notes to be archived.
