# Raphael

## What this is

Raphael is a second brain for agents. It combines PARA and CODE to organize information as actionable notes rather than passive resources.

## Structure

- `apps/mobile` (coming next) is the Expo frontend for Android and iOS and the primary way to use Raphael from a phone.
- `apps/backend` (coming next) owns backend behavior, persistence, and the canonical stored data.
- `apps/web` (coming next) is the web frontend for using Raphael outside the mobile clients.

## Rules

- Always start by reading:
  - `docs/engineering-guidance/README.md`
  - `docs/engineering-guidance/principles.md`
  - `docs/engineering-guidance/how-to-use.md`
  - `docs/adrs/README.md` (use it as an index; read only ADRs relevant to the task)
  - Additionally, make sure to read any relevant engineering guidance files before starting to code.
- Never hard-wrap prose in Markdown files. Keep each paragraph and list item on one source line.
- After code changes, run `pnpm check`. Each package has its own `check` command. Use `pnpm fix` to fix formatting issues.
- Never start long-running processes such as servers or run `pnpm run dev` or `pnpm run start`. Instead, suggest that the user run those commands.
- Do not run state-changing Git commands unless the user explicitly asks. Read-only Git commands such as diffs, status, and commit history are allowed.
- We have not launched yet, so prefer bold refactors for better maintainability and correctness over backwards compatibility.
