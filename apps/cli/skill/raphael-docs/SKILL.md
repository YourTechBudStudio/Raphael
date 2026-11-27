---
name: raphael-docs
description: Work in the user's Raphael second brain through the raphael CLI. Capture notes, projects and areas in the right place; find and read stored context; update, move, archive and restore items; recover from CLI failures. Use when the user asks to remember, save, file, look up or organize something in Raphael, or when a task needs context the user keeps there.
---

# Raphael

Raphael is the user's second brain: areas for ongoing responsibilities, projects for bounded outcomes, and notes holding the content that serves them. You reach it through the `raphael` CLI. Read only the reference the action needs; links are relative to this file.

`raphael help <command>` and `raphael help <topic>` are the contract for flags, limits, output and exit codes, and they win when this skill disagrees with them. The user's instructions win over this skill's conventions. Pass `--json` whenever you parse a result.

Before filing or reorganizing anything, look at the user's existing structure (`raphael list /`, then `raphael list <area> -r`) and work within it.

| Action                                                                              | Read                               |
| ----------------------------------------------------------------------------------- | ---------------------------------- |
| Connect to a server, check the connection, fix a login                              | [Setup](references/setup.md)       |
| Save something new: choose its home, then shape its title, body, tags and metadata  | [Capture](references/capture.md)   |
| Look up context before answering, planning or doing work                            | [Find](references/find.md)         |
| Edit a body, title, description, tags, slug or project state                        | [Change](references/change.md)     |
| Move, archive or restore items; finish a project; favorites                         | [Organize](references/organize.md) |
| A command failed, or a write's outcome is unclear                                   | [Recover](references/recover.md)   |
| Choosing a home is still unclear, or the user asks to distill or act on their notes | [Method](references/method.md)     |
