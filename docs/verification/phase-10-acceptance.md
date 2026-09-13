# Phase 10 coordinating checklist

Everything still needed before story #2 can be called accepted, in one place.

This is a coordinator, not a replacement. The phase 08 and phase 09 checklists remain the procedures of record for their own phases, with their own setup instructions and their own "what would be wrong" wording, and they are referenced here by section and number rather than copied. Where one of them has already been run, the result stays recorded in `scratch/plans/durable-hierarchy/decisions.md` and is not re-asked here.

Nothing on this page has been established by automation. The agent-run acceptance suite - `pnpm acceptance` - covers the installed artifact, and the package suites cover behaviour; the criterion-to-evidence matrix in the decision log says exactly which criteria they close and which they only partly close. What is left is what needs a person, a device, or a network the automation cannot reach.

## Before anything

Use a throwaway key and a temporary database. Never point these checks at a database you care about.

```sh
export RAPHAEL_API_KEY="dev-$(openssl rand -hex 24)"
echo "$RAPHAEL_API_KEY"          # paste this into the phone when asked
pnpm server:dev                  # leave running; keeps its database at ./data/ (git-ignored)
```

`pnpm mobile:start` starts Expo. `node apps/cli/src/main.ts` is the CLI; it reads `RAPHAEL_ENDPOINT` and `RAPHAEL_API_KEY`, or a saved `login`. Phase 09's checklist has the fuller setup, including the proxy that drops answers.

## A. Still open from phase 08

From `phase-08-mobile-reads.md`, section **The checks**. None of these has been run in its own right; connecting and browsing were exercised on the way to phase 09's creation checks, which is not the same thing.

- [ ] **3. Multi-page loading** - more than 500 containers, whole tree appears at once.
- [ ] **4. A later page failing** - stop the server mid-load; no partial tree, retry offered.
- [ ] **5. A stale tree** - background and foreground with the server down; last complete reading, labelled.
- [ ] **10. A rejected key** - restart with a different key; one notice, no retry storm.
- [ ] **11. Rotation** - same address, new key; stars and session notes survive.
- [ ] **12. Switching servers** - second server; stack resets, nothing of the first leaks, including same numeric ids.
- [ ] **13. A replacement that cannot be saved** - if the keychain can be made to refuse.
- [ ] **14. Disconnect** - asks first, returns to setup, reopening still asks for a key.
- [ ] **15. iOS** - the whole phase 08 list, on iOS. Not yet opened.

## B. Still open from phase 09

From `phase-09-mobile-creation.md`, section **The checks**. Checks 1, 2 (as "an ordinary creation"), 5, 13, and the "exactly one container after Try again" half of 10 were run by the owner on Android and are recorded. The rest were covered by a general "everything works" and are not recorded as individual passes.

- [ ] **14. Expiry** and **15. A clock that moves backwards** - section **Time**. Explicitly not run. Do these on a device rather than treating them as covered by the unit tests: what a device adds is the app being suspended and resumed across the change, and the platform's own clock behaviour across that transition, not the arithmetic.
- [ ] **16, 17, 18** - section **Discarding**, the three dialogs, each said to differ from the others.
- [ ] **19 through 23** - section **Connection**.
- [ ] **24. Large text and reduced motion** - section **Presentation**.
- [ ] **25. iOS** - the whole phase 09 list, on iOS. Not yet opened.

## C. New in phase 10

### Installed login

The acceptance suite establishes that an installed `raphael login` refuses a terminal it cannot hide input in, and that an installed command reads a correctly protected configuration it did not write. It cannot establish a successful interactive login, which needs a real terminal.

Install the packed CLI the way the suite does, or run `node apps/cli/src/main.ts` if you would rather not, and then:

- [ ] **26. The key is not echoed.** Run `login` and type a key. Nothing appears as you type - no characters, no bullets. _Wrong:_ the key visible on screen or left in scrollback.
- [ ] **27. Verification precedes saving.** Log in with a deliberately wrong key. It fails, and no configuration file is written. Then log in correctly and confirm the file appears with owner-only permissions (`ls -l ~/.config/raphael/config.json` shows `-rw-------`).
- [ ] **28. A failed verification preserves what was there.** With a working saved login, run `login` again and give a wrong key. It fails, and the previous configuration is **unchanged and still works**. _Wrong:_ a broken credential left in place, which is the failure the verify-then-write ordering exists to prevent.
- [ ] **29. Ctrl-C leaves a usable terminal.** Cancel at the key prompt. Echo is restored - type something and see it.

### Cross-client parity, against one instance

One server, one phone, one CLI, all pointed at the same place.

- [ ] **30. CLI creates, mobile reads.** Create a nested area and a project with the CLI, including one with a Markdown body. The phone shows them in the right places, and the body is visible and read-only.
- [ ] **31. Mobile creates, CLI reads.** Create an area and a project on the phone. `list / --recursive` shows both, with the paths the phone displays.
- [ ] **32. Both survive a restart of both.** Stop and restart the server; force-quit and reopen the app. Everything is still there on both sides, and the phone does not ask for the key again.
- [ ] **33. Endpoint isolation, end to end.** Point the phone at a second instance. Nothing from the first appears, including containers sharing a numeric id. Point it back; the first instance's data returns.

### Platform and transport

- [ ] **34. A physical Android device over HTTPS.** An address the phone can actually route to, with real TLS. The key must not travel in the clear. This is the deployment path; it does not reinstate any client-side address restriction, which was deliberately withdrawn in phase 07. _Wrong:_ being unable to connect at all, or a certificate error presented as a generic failure.
- [ ] **35. iOS, at least once.** Connect, browse, create, and recover an unfinished attempt. Every platform judgment in this product currently rests on Android and on reasoning. Note the device or simulator, the OS version, and the build type.
- [ ] **36. Record what was exercised.** For each of the above: device or simulator, OS version, build type (Expo Go, development build, release), and the date. A check without that context cannot be reasoned about later.

## What to do with the results

Add them under `phase-10-acceptance` in `scratch/plans/durable-hierarchy/decisions.md`, keeping five states apart and never collapsing them: automated work complete, human observation reported, required check pending, access blocked, and scope explicitly reduced by the owner. A check nobody ran is pending or blocked; it is never a pass by reasoning.
