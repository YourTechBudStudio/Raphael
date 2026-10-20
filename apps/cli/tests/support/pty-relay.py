# Run a command under a pseudo-terminal and relay it through plain pipes.
#
# Used by the login terminal tests. `script` would be the obvious tool, but on macOS it refuses to
# start unless its own standard input is already a terminal, which a test harness's pipe never is.
# This does the same job with the standard library: everything the command's terminal displays comes
# out on stdout, and stdin is typed into the terminal as keystrokes. Exits with the command's status.
#
# Usage: python3 -I pty-relay.py <executable> [args...]

import os
import pty
import select
import sys

pid, terminal = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])

sources = [terminal, sys.stdin.fileno()]
while terminal in sources:
    readable, _, _ = select.select(sources, [], [])
    if terminal in readable:
        try:
            data = os.read(terminal, 4096)
        except OSError:
            # The command exited and its side of the terminal is gone.
            data = b""
        if data:
            os.write(sys.stdout.fileno(), data)
        else:
            sources.remove(terminal)
    if sys.stdin.fileno() in readable:
        data = os.read(sys.stdin.fileno(), 4096)
        if data:
            os.write(terminal, data)
        else:
            sources.remove(sys.stdin.fileno())

_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
