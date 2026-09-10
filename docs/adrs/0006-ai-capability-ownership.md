# ADR 0006: AI capability ownership

## Status

Accepted as architectural direction; implementation is not implied.

## Context

Common AI tasks should not require each extension to integrate providers and credentials. Supporting interchangeable agent SDKs now would add abstraction without a current need; audio transcription still needs a capability beyond Pi's documented inference interface.

## Decision

Core provides agent execution through Pi Agent Core, LLM inference through Pi AI, and transcription through a Raphael adapter sharing Pi-managed authentication. Raphael delegates credential storage, resolution, and refresh to Pi's supported auth facilities rather than implementing a parallel auth stack.

Authentication configuration and capability routing are separate: Raphael centrally selects a provider/model for each operation and rejects unsupported combinations. Operations may route to different configured providers. There is no silent cross-provider fallback.

Extensions use Raphael's capability interface, not Pi SDK objects or credentials, and cannot select providers. Agents receive explicitly granted tools and use core operations rather than unrestricted database access.

## Consequences

- The Raphael interface enforces ownership and configuration, not speculative SDK interchangeability.
- Central routing keeps credential handling and data destinations consistent across extensions. Provider availability does not imply support for every capability; the initial integration is described in [Runtime and access](../architecture/runtime-and-access.md).
- Provider authentication is distinct from client authentication to Raphael; clients do not receive provider credentials.
