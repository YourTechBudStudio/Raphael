# ADR 0005: Canonical content and search

## Status

Accepted as architectural direction; implementation is not implied.

## Context

The editor needs structured documents, while agents and extensions need convenient Markdown input and output. Two canonical formats would split editing and indexing behavior.

## Decision

Areas, projects, and resources have titles, plain-text descriptions, and bodies stored as validated TipTap JSON. Core accepts Markdown or TipTap input, converts Markdown using established libraries, and owns the supported document schema. Markdown is the default input/export format; TipTap is explicitly selectable. Extensions use this common content contract rather than supplying custom search extraction.

Core derives plain body text and maintains full-text indexing from canonical content. Index title, description, and body text together as distinct searchable fields, allowing field-aware matching and relevance weighting. Metadata and tags use structured filters, not full-text indexing.

## Consequences

- Markdown export is best-effort, not a lossless rich-document round trip. Code-block conventions can represent supported rich elements without guaranteeing reconstruction of every element.
- Unsupported TipTap structures are rejected rather than silently discarded.
- Search text is rebuildable derived state, not a separately authored body. Engine-specific indexes and ranking settings are implementation choices.

See [ADR 0001](./0001-retrieval-and-search-authority.md) for scoped extension-assisted search, which remains separate from core indexing.
