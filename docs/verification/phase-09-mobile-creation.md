# Phase 09 human checklist

What an agent cannot establish on its own. Everything below needs a real server, a real device, and someone watching. Start the persistent processes yourself; nothing here should be left running by a tool.

The automated tests cover the state machine, the storage rules against real SQLite, and one end-to-end creation whose response is lost after the server committed. None of them establishes what happens when Android actually kills the process, what `expo-sqlite` actually does on a device, or how any of this reads to a person. That is what this list is for.

## Setting up

Four terminals. The first three stay running.

### 1. A key, and the server

The server needs an API key in its environment and will not start without one. Generate a throwaway:

```sh
export RAPHAEL_API_KEY="dev-$(openssl rand -hex 24)"
echo "$RAPHAEL_API_KEY"          # you will paste this into the phone
pnpm server:dev
```

It builds the backend and listens on `127.0.0.1:3000`, keeping its database at `./data/raphael.sqlite` (already git-ignored). A fresh database seeds two areas, Work and Personal.

To keep the key out of your shell history instead, put `RAPHAEL_API_KEY=...` in a `.env` beside where you run the command; the server reads it from there and the environment wins over the file. Do not commit it.

### 2. The proxy that loses answers

Three of the checks need a creation the server commits and the phone never hears about. By hand that is a race nobody can win, so run this between the phone and the server:

```sh
node apps/mobile/tests/support/dropping-proxy.mjs --target http://127.0.0.1:3000 --port 3001
```

It forwards everything faithfully until you press **d**, which arms it: the next creation is passed to the server, the server's answer is drained in full, and then the connection is dropped. The area really exists and the phone really does not know. Press **q** to quit.

**Point the phone at the proxy (`3001`), not at the server**, so it is there when you need it.

### 3. Expo

```sh
pnpm mobile:start                 # then press a for Android, i for iOS
```

### 4. The CLI, for setting things up and checking afterwards

```sh
export RAPHAEL_ENDPOINT=http://127.0.0.1:3000
export RAPHAEL_API_KEY=...        # the same key
node apps/cli/src/main.ts list / --recursive
```

Or `node apps/cli/src/main.ts login` to save it instead. Use the CLI against **the server**, not the proxy, when you want the truth about what exists.

Build a hierarchy worth reading:

```sh
node apps/cli/src/main.ts create area /work/clients --title "Clients"
node apps/cli/src/main.ts create project /work/clients/design --title "Design"
```

### Connecting the phone

- **Android emulator:** `http://10.0.2.2:3001` — the emulator's alias for your machine's loopback.
- **Physical device:** your machine's LAN address, e.g. `http://192.168.1.20:3001`. The proxy listens on all interfaces. For the server itself you would need `server.host: 0.0.0.0` in a YAML config; the proxy removes that need.
- Paste the key into the second field. Plain HTTP to any host is accepted deliberately, which means **the key travels in the clear** — use a throwaway one.

## The checks

Each one names what would be wrong, not only what to do.

### Creating

1. **An ordinary creation.** Browse → New area, give it a title, Save. The sheet closes and the new area opens. Browse shows it. _Wrong:_ a spinner that never resolves, landing back on Browse without the area, or the area appearing only after a manual refresh.
2. **A creation with a note.** Create a project inside an area with something written in the body. Open it: the body is there, read-only, with the whitespace you typed. _Wrong:_ a trimmed or reflowed body.
3. **An empty title.** Press Save with no title. The sheet says so and nothing is sent — the server log shows no request. _Wrong:_ a round trip, or a container named after the body.
4. **A duplicate title.** Create an area, then another with the same title in the same place. The refusal is shown, the title is preserved, and changing it and saving succeeds. _Wrong:_ a slug field appearing, a number appended for you, or the title cleared.
5. **A correction keeps the note.** Cause that same duplicate refusal with a body written. Change the title and save. Open the result: the body you wrote is still there. _Wrong:_ an empty body — correcting a refusal replaces the record, so the body would be gone for good.
6. **Double tap.** Tap Save twice quickly. One request in the server log, one container.
7. **Where creation is offered.** Browse offers New area only. An area offers both. A project offers neither. _Wrong:_ a project offering to hold an area.

### The lost answer

8. **A creation the phone cannot confirm.** Press **d** in the proxy terminal, then create an area on the phone. The proxy prints that it dropped the answer. The sheet says Raphael cannot tell whether it was created; the wording never says it failed. _Wrong:_ "could not create", or a claim either way.
9. **The record survives the sheet.** Close that sheet. The attempt is listed on Home and under Unfinished, with its title and the time. _Wrong:_ it disappearing because the sheet closed.
10. **Resolving it.** Try again on that attempt. It resolves to a created area — and `node apps/cli/src/main.ts list / --recursive` shows **exactly one**, not two. _Wrong:_ two containers with the same title, which would mean the key was not reused.
11. **Checking the destination.** Arm and drop another one, then use View destination. It opens the parent, or Browse for a top-level attempt, and creates nothing. _Wrong:_ any creation in the server log.
12. **Creating it separately.** On an unresolved attempt, Create it separately. The confirmation says the earlier one may exist; afterwards you have two entries with different statuses, and the earlier record is still there. _Wrong:_ the original vanishing.
13. **Process kill after dispatch.** Arm the proxy, tap Save, and force-quit the app — Android's Force stop, not a swipe. Reopen. The attempt is listed as one Raphael cannot confirm, with the original title. _Wrong:_ the attempt gone, the app resending on its own, or it described as failed.

### Time

14. **Expiry.** With the app closed, set the device clock forward more than 71 hours, then reopen. The unresolved attempt still shows its title, no longer offers Try again, and says the retry window has ended — not that the attempt expired or was lost. _Wrong:_ Try again still offered, or the record removed.
15. **A clock that moves backwards.** With an unresolved attempt pending, set the clock back an hour. Try again is withdrawn and the wording says the clock changed. Set it forward past where it was: it stays withdrawn. _Wrong:_ the retry coming back.

Set the clock back to automatic afterwards.

### Discarding

16. **An unresolved attempt.** Discard warns that this cannot undo a creation the server may have made, and only then removes it.
17. **A refusal.** Discard a refused attempt. The warning says the server refused it and nothing was created — no ambiguity language. _Wrong:_ the same dialog as 16.
18. **A result.** Dismiss a created result. Nothing is asked, because nothing is at risk.

### Connection

19. **A refused key.** Restart the server with a different key. Creation controls will not save, and say the server is not accepting requests. _Wrong:_ a creation being dispatched and recorded against a connection already known to be refusing.
20. **Disconnect and recover.** With an unresolved attempt, disconnect in Settings. The setup screen lists the attempt under its old address, readable, with discard available and no Try again. _Wrong:_ the attempt gone, a retry offered with no connection, or setup showing nothing.
21. **An unreadable keychain.** If you can corrupt the stored connection, the screen that says so also lists unfinished attempts.
22. **Reconnecting to the same server.** Connect again to the same address. The attempt is listed under "From another server" and Try again is not offered — the device mints a new identity after a disconnect. **This is a recorded limitation, not a bug.** The point is that the record is still there and still readable.
23. **A read failure after a save.** Create something, then stop the server before the hierarchy refreshes. The creation is still reported as successful and the container opens; the hierarchy separately says it could not refresh. _Wrong:_ a successful save reported as a failure because a read failed.

### Presentation

24. **Large text and reduced motion.** The sheet, the attempt cards, and the recovery screen stay readable and reachable, and the keyboard does not cover Save. Failure lines are announced.
25. **iOS.** Everything above, on iOS. Nothing in this phase has run there.

## Afterwards

```sh
rm -rf data/                      # the server's database
```

The phone's own record lives in app storage; clear app data, or uninstall, to reset it.

## What is still open after this list

- The `expo-sqlite` binding itself. Every automated storage test runs on `node:sqlite` through the same port, which is real SQLite and not the native adapter.
- The phase 08 checks, which remain outstanding in their own right. Green phase 09 tests do not close them.
