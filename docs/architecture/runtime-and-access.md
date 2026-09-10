# Runtime and access

This describes agreed direction, not implementation status.

## Server and clients

The backend owns canonical records and exposes operation-oriented HTTP APIs. Selectors and inputs belong in request bodies rather than separate path/query addressing schemes. Read operations remain read-only regardless of transport.

One Raphael CLI has two roles: local server administration, including startup and AI provider login, and remote client operations against a configured endpoint. Server administration works on the backend machine's files and credentials; it is not exposed as remote administration.

Clients and extensions use the same core operations and validation. Extensions call the Raphael SDK internally without HTTP. The CLI provides ergonomic composition without becoming a separate source of business rules or a pluggable extension host.

## Access boundary

Each instance is a single-owner second brain with one configured API key granting full API access. Mobile, web, CLI, and agent clients use the same key; there are no user accounts, roles, or independently revocable client keys. Client setup supplies an endpoint and key. Rotation requires updating every client.

Keys travel in authorization headers over HTTPS outside local connections, not in URLs. A missing server API key fails closed. Global API access does not grant arbitrary database access or expose server-local administration and provider secrets.

AI provider authentication is separate from client access and delegates to Pi, as defined in [ADR 0006](../adrs/0006-ai-capability-ownership.md).

## Initial backend direction

Use Express, Turso Database (the Rust rewrite, not libSQL), and Drizzle. Turso's Tantivy-backed search indexes title, description, and body text with descending field priority. Verify the selected driver/engine combination for recursive hierarchy queries, JSON filtering, transactions, and FTS rather than assuming SQLite feature parity.

Start all AI capabilities with ChatGPT subscription authentication. Transcription follows Toph's adapter approach against a ChatGPT backend endpoint, not the public OpenAI transcription API or a built-in Pi feature. Pi auth/storage integration and endpoint compatibility require verification. These integration choices do not alter the authority boundaries in the ADRs.
