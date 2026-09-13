# Phase 08 human checklist

What an agent cannot establish on its own. Everything below needs a real server, a real device, and someone watching. Start the persistent processes yourself; nothing here should be left running by a tool.

## Setting up

```sh
pnpm server:dev            # starts the backend; leave it running in its own terminal
pnpm mobile:start          # Expo; press a for Android, i for iOS
```

The server prints the address it is listening on and needs an API key in its environment. An Android emulator reaches a loopback server at `http://10.0.2.2:<port>`; a physical phone needs an address it can actually route to, and Raphael accepts plain HTTP to any host, which means the key travels in the clear on anything but HTTPS.

Use the CLI to make a hierarchy worth reading:

```sh
node apps/cli/src/main.ts login
node apps/cli/src/main.ts create area /work/clients --title "Clients"
node apps/cli/src/main.ts create project /work/clients/design --title "Design"
```

The path is the complete address the new container will occupy: the parent is everything before the last segment, and the last segment is its slug. `raphael create --help` has the id form.

## The checks

Each one names what would be wrong, not only what to do.

1. **Relaunch persistence.** Connect, force-quit the app, reopen it. It opens straight into the hierarchy with no setup screen and no spinner beyond the first read. _Wrong:_ being asked for the key again, or a flash of the setup screen before the app appears.
2. **A CLI-created hierarchy, and paths.** Browse shows Work and Personal and everything created above, nested correctly and in slug order. Open a nested area and a project; the path chip names the ancestors. _Wrong:_ a flat list, an area appearing under the wrong parent, or a path chip that stays on "Areas" after the tree has loaded.
3. **Multi-page loading.** Create more than 500 containers with the CLI, then open Browse. The whole tree appears at once. _Wrong:_ a tree that stops at 500, or one that grows while you watch it.
4. **A later page failing.** With more than 500 containers, stop the server while Browse is loading. The tree does not appear at all, and the failure offers a retry. _Wrong:_ a partial tree on screen, or a "no areas or projects" empty state.
5. **A stale tree.** Load Browse successfully, stop the server, pull the app to the background and back. The tree is still there, with a line saying it is the last complete reading and a Try again button. _Wrong:_ the tree disappearing, or the stale line missing.
6. **Required area selection.** From Home, and again from inside an area, open New note. Save is disabled until an area is tapped, and nothing is preselected in either case. _Wrong:_ Save enabled on opening, or the area you were looking at already chosen.
7. **Path disambiguation.** Create two areas called "Notes" under different parents. The note sheet's picker shows both, each with the parent under it. _Wrong:_ two identical rows.
8. **A draft surviving a slow list.** Type a note, stop the server, and watch the picker fail. The title and body are still there, and retrying the picker does not clear them. _Wrong:_ losing what was typed.
9. **Offline and back.** Turn off the server. Screens say what they could not read and offer retry. Turn it back on and foreground the app; the data returns. _Wrong:_ an empty state that reads as "you have nothing", or data that never comes back without a manual restart.
10. **A rejected key.** Restart the server with a different key. Every screen you open carries one notice saying the key was refused, with Try again and Change server. Settings still shows the connection. _Wrong:_ silently returning to setup, the key being forgotten, a retry storm, or a screen that only says "did not load".
11. **Rotation.** Change server to the same address with the new key. Your stars and session notes are still there afterwards.
12. **Switching servers.** Point the app at a second server with its own hierarchy. The stack resets to Home, and none of the first server's areas, notes, or stars appear — including when both servers have a container with the same number.
13. **A replacement that cannot be saved.** Hard to force by hand; if you can make the keychain refuse, the old connection stays live and the setup screen says the new one could not be saved.
14. **Disconnect.** Settings → Disconnect. It asks first, then returns to setup. Reopening the app still asks for a key.
15. **iOS.** Everything above, plus: the creation-free Browse as a card rather than a modal, safe areas, keyboard avoidance on the setup screen and the note sheet, and 44pt hit targets. **Not yet run.**

## What is not claimed

- iOS has not been opened. Every platform judgment in this phase rests on Android and on reasoning.
- No screenshots or recorded traces exist for any of the above.
- The web build shows an unsupported-platform screen by design; there is nothing to verify there beyond that it appears.
