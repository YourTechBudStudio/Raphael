# Setup

Run `raphael status --json` first. Exit 0 means every other command can reach the server.

- **No connection** (exit 5, `not_configured`): ask whether the user already has a server. If not, tell them what running one requires; starting it is theirs to do in their own terminal. A server needs an owner-only `.env` file holding `RAPHAEL_SERVER_API_KEY` in the directory where `raphael server serve` runs, and keeps running in that terminal. The root page of `raphael help` gives the command that creates the key file safely.
- **Logging in**: the API key is a secret. `raphael login <address>` reads it from a hidden prompt, so ask the user to run it. When the key is already in an environment variable, pipe it: `printf '%s\n' "$KEY" | raphael login <address> --api-key-stdin --json`. Keep the key out of command arguments, files you write, and your replies. `RAPHAEL_ENDPOINT` and `RAPHAEL_API_KEY`, set together, replace a saved login.
- **Different releases**: a `version_skew` warning or an `incompatible_protocol` error means the CLI and server differ; tell the user which side to update.
- **Server unreachable** (exit 6): nothing was applied. Check that the server is running at the address `status` reports.

Details: `raphael help connecting`.
