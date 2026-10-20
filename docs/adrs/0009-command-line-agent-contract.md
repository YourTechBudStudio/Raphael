# ADR 0009: Command line as an agent-facing contract

## Status

Accepted as architectural direction; implementation is not implied.

## Context

The `raphael` CLI is how agents and scripts reach Raphael, and agent skills build on it. Agents learn commands from help, branch on exit codes, and parse output. Help that drifts from behavior, failure classes that cannot be told apart, and results mixed with diagnostics cause retries, wrong conclusions, and duplicated writes. Copy written separately from the rules it describes drifts as the model evolves.

## Decision

Each command module defines its command once, beside its handler: usage, options with value forms and defaults, behavior, and examples. Argument parsing, command pages, the root page, and machine-readable help derive from those definitions; dispatch stays explicit code. Cross-cutting rules live in help topics. Descriptions of model rules such as types, kinds, containment, slug grammar, filter values, and content limits render from contracts constants rather than being restated.

Standard output carries only results: rows, or exactly one JSON document with `--json`. Prompts, hints, warnings, paging notes, and failures go to standard error. With `--json`, success is one documented envelope and failure one documented error document, including usage failures. Both are stable within a major version. A reader that closes early is not a failure.

Exit codes classify what the caller should do next, not where a check ran: success; refused without change, by category (usage, not found, state conflict, configuration or authorization); and outcome unknown. Once a write has been sent, a failure never claims the write did not happen. Signal interruption keeps the conventional codes.

The CLI checks input with the contracts' exported inspectors before reading content or contacting the server. The server remains the authority, and the client's request decoder is a backstop that never speaks first. Server failures carry structured details such as the field, target, current revision, or blocking item, with generic messages that do not echo input. The CLI writes the final wording, because only it knows what the caller typed, and keeps the server's message in JSON output.

## Consequences

- Adding a command or option means extending its definition; parsing and help follow without separate edits.
- Help and failure copy are regression-tested as golden files that enumerate every error code and rejection reason, so a new member without an expectation fails the build.
- Changing the JSON envelope or the meaning of an exit code breaks agents and requires a deliberate version decision.
- Listings include computed paths only when the request asks for them, consistent with [ADR 0004](./0004-canonical-data-and-addressing.md); the CLI asks.
- Other clients may use the structured failure details; this record does not prescribe their wording.
- `server serve` follows the same stream, exit-code, and help rules.

See [Runtime and access](../architecture/runtime-and-access.md) for the CLI's two roles and why it composes core operations without becoming a separate source of business rules.
