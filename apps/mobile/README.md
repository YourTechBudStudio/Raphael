# Raphael mobile

The Expo SDK 57 phone client, using Expo Router and TypeScript. The initial screen is a placeholder; no notes are stored yet.

## Development

Install dependencies with `pnpm install` from the repository root, then start the app yourself:

```sh
pnpm --filter @raphael/mobile start
```

Use `pnpm --filter @raphael/mobile ios` or `pnpm --filter @raphael/mobile android` to open a simulator or emulator. `pnpm --filter @raphael/mobile web` provides a browser preview, not the planned standalone web client. Physical devices require a matching Expo Go version or a development build.

## Verification

```sh
pnpm --filter @raphael/mobile check
```

This lints, exports iOS/Android/web bundles, typechecks, and checks formatting. Exporting bundles is not a native compilation or device smoke test. Run `pnpm check` at the repository root to verify the full workspace.
