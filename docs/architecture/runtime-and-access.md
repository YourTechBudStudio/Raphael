# Runtime and access

This describes agreed direction, not implementation status.

## Server and clients

An Express backend owns canonical records and exposes operation-oriented HTTP APIs. Core requests use POST with selectors and inputs in JSON bodies, not path or query parameters; media upload and download use binary transport. Read operations remain read-only regardless of HTTP verb.

One Raphael CLI has two roles: local server administration, including startup and AI provider login, and remote client operations against a configured endpoint. Server administration works on the backend machine's files and credentials; it is not exposed as remote administration.

Clients and extensions use the same core operations and validation. Extensions call the Raphael SDK internally without HTTP. The CLI provides ergonomic composition without becoming a separate source of business rules or a pluggable extension host.

## Access boundary

Each instance is a single-owner second brain with one configured API key granting full API access. Mobile, web, CLI, and agent clients use the same key; there are no user accounts, roles, or independently revocable client keys. Client setup supplies an endpoint and key. Rotation requires updating every client.

Keys travel in authorization headers over HTTPS outside local connections, not in URLs. A missing server API key fails closed. Global API access does not grant arbitrary database access or expose server-local administration and provider secrets.

AI provider authentication is separate from client access and delegates to Pi, as defined in [ADR 0006](../adrs/0006-ai-capability-ownership.md).
