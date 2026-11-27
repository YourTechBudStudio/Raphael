# ADR 0010: Agent skill scope and upkeep

## Status

Accepted as architectural direction; implementation is not implied.

## Context

The `raphael-docs` skill in `apps/cli/skill/` teaches agents to use Raphael through the CLI. Command help already owns the mechanics and derives from command definitions ([ADR 0009](./0009-command-line-agent-contract.md)), so anything the skill restates drifts. A feature the skill never mentions goes unused by agents that do not know to reach for it, while a skill that grows with every option becomes too long for agents to read selectively.

## Decision

The skill owns judgment; help owns mechanics. The skill says when and why to use a capability, how it serves the second-brain method, and which sequences across commands keep data safe. Help says how: syntax, options, defaults, limits, formats, output fields, and error codes. The skill names the help command or topic instead of repeating it, and inlines a mechanical fact only when getting it wrong would lose data or mislead the user.

A change updates the skill in the same change when it:

- adds or changes the meaning of a concept an agent must reason about, such as an item type, resource kind, state, or field with its own purpose;
- adds a capability an agent would not reach for unprompted, or changes when one capability should be chosen over another;
- changes a safe sequence across commands: what must be read first, what must be pinned, or how to recover;
- makes a previously unsupported request supported, or the reverse;
- renames or removes a command, option, or help topic the skill names.

Everything else stays in help: new options, limits, defaults, output fields, error codes, and wording that a command page already explains.

The index routes by action, and each action file carries short inline rules. Method depth lives once, in the method reference. A new action file is added only for something an agent would set out to do on its own; anything else extends an existing file. The skill ships with the CLI, so an installed copy matches the release that installed it.

## Consequences

- Review of a feature asks whether it changes what an agent decides, not whether it is documented somewhere.
- The skill stays small as the CLI grows; detail accumulates in help, where it is generated and tested.
- A test checks every command, option, and help topic the skill names against the command definitions, so a rename or removal fails the build. Whether the skill's judgment is still right cannot be checked mechanically and remains a review responsibility.
- Conventions for features that do not exist yet, such as task states, stay out of the skill until the feature exists, so agents do not create data that a later model has to migrate.
