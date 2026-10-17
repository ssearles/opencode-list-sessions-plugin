#!/usr/bin/env python3
"""
Prove closing the window ends the process.

Instances were surviving with no window mapped, invisible but still running,
stacking up one per launch until they had to be killed by hand. This drives the
real main loop and closes the window the way the Close button does, then checks
the process actually exits.
"""

import os
import subprocess
import sys
import textwrap
from pathlib import Path

# The popup under test. Defaults to this repo's copy so the suite tests what is
# committed rather than whatever happens to be installed in ~/.local/bin;
# override with SESSION_POPUP when testing an installed build specifically.
SCRIPT = Path(
    os.environ.get("SESSION_POPUP")
    or Path(__file__).resolve().parent / "session-list-popup"
)

PASS, FAIL = [], []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  {'ok  ' if cond else 'FAIL'}  {name}{'  — ' + detail if detail else ''}")


def stale():
    out = subprocess.run(["pgrep", "-f", "bin/session-list-popup"],
                         capture_output=True, text=True).stdout.split()
    return [p for p in out if p.isdigit()]


print("\npreconditions")
check("no popups running before the test", len(stale()) == 0, f"{len(stale())} running")

# The real entry point, but with a timer that closes the window the way the
# Close button does (destroy()) so the exit path is exercised for real.
harness = textwrap.dedent(f"""
    import runpy, sys, threading, time
    import gi
    gi.require_version("Gtk", "3.0")
    from gi.repository import GLib

    orig = GLib.timeout_add
    def patched(interval, fn, *a, **k):
        # Fire the Close button's destroy() at 2.5s.
        if interval == 2000:
            def close():
                for w in __import__("gi").repository.Gtk.Window.list_toplevels():
                    if w.get_title() == "OpenCode sessions":
                        w.destroy()
                return False
            orig(1500, close)
        return orig(interval, fn, *a, **k)
    GLib.timeout_add = patched

    sys.argv = ["session-list-popup"]
    runpy.run_path("{SCRIPT}", run_name="__main__")
""")

print("\nthe process exits when the window is closed")
try:
    r = subprocess.run([sys.executable, "-c", harness], capture_output=True,
                       text=True, timeout=25)
    exited = True
except subprocess.TimeoutExpired:
    exited = False

check("process exited rather than hanging", exited,
      "still running 25s after its window was closed")
if exited:
    check("clean exit, no traceback", r.returncode == 0,
          f"exit {r.returncode}")
    if "Traceback" in r.stderr:
        tail = [l for l in r.stderr.splitlines() if l.strip()][-3:]
        check("no traceback in stderr", False, " | ".join(tail))
    else:
        check("no traceback in stderr", True)

import time
time.sleep(2)
check("no orphaned process left behind", len(stale()) == 0, f"{len(stale())} still running")

print("\nrepeat launches do not accumulate")
survivors = []
for i in range(3):
    try:
        subprocess.run([sys.executable, "-c", harness], capture_output=True,
                       text=True, timeout=25)
    except subprocess.TimeoutExpired:
        survivors.append(i)
time.sleep(2)
check("three launch-and-close cycles leave nothing running",
      len(stale()) == 0 and not survivors,
      f"{len(stale())} survivors")

print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
sys.exit(1 if FAIL else 0)