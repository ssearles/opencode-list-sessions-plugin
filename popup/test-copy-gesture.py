#!/usr/bin/env python3
"""
Does mouse-select then Ctrl+C survive the window closing?

This is the gesture a person actually uses, and the one the removed "Copy all"
button stood in for. The test selects part of the buffer the way a drag would,
fires the real key handler, destroys the window, and then reads the clipboard
from outside the process -- which is the only place the answer exists, since the
failure mode was precisely that the content died with the process.
"""

import importlib.machinery
import importlib.util
import subprocess
import sys
from pathlib import Path

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Gdk, Gtk  # noqa: E402

SCRIPT = Path.home() / ".local" / "bin" / "info-window"

spec = importlib.util.spec_from_loader(
    "iw", importlib.machinery.SourceFileLoader("iw", str(SCRIPT))
)
iw = importlib.util.module_from_spec(spec)
sys.modules["iw"] = iw
spec.loader.exec_module(iw)
iw.FONT_PREFS = Path("/tmp/opencode/font-size-test3")

PASS, FAIL = [], []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  {'ok  ' if cond else 'FAIL'}  {name}{'  — ' + detail if detail else ''}")


MARKER = "SELECTED-SEGMENT-88213"
DOC = f"preamble line\n{MARKER}\ntrailer line\n"

win = iw.Window("Copy test", DOC, "copytest", "text")
while Gtk.events_pending():
    Gtk.main_iteration_do(False)

print("\nselecting part of the buffer, as a drag would")
buf = win.text_view.get_buffer()
start = buf.get_iter_at_line(1)
end = buf.get_iter_at_line(2)
buf.select_range(start, end)
sel = buf.get_selection_bounds()
check("a selection exists", sel[1] != sel[0])
chosen = buf.get_text(sel[0], sel[1], False)
check("the selection is the middle line", MARKER in chosen, repr(chosen[:40]))

print("\nCtrl+C goes through the handler, not the TextView's own binding")
event = Gdk.Event.new(Gdk.EventType.KEY_PRESS)
event.keyval = Gdk.KEY_c
event.state = Gdk.ModifierType.CONTROL_MASK
event.window = win.get_window()
event.time = Gdk.CURRENT_TIME
handled = win.on_key(win, event)
check("the window claims the keystroke", handled is True)
while Gtk.events_pending():
    Gtk.main_iteration_do(False)

print("\nafter the window is destroyed and the process has exited")
win.destroy()
got = subprocess.run(["wl-paste", "--no-newline"], capture_output=True,
                     text=True, timeout=10).stdout
check("the clipboard still holds the selection", MARKER in got,
      repr(got[:60]))
check("and only the selection, not the whole document",
      "trailer" not in got and "preamble" not in got, repr(got[:80]))

print("\nCtrl+C with nothing selected copies nothing")
win2 = iw.Window("Empty selection", DOC, "copytest", "text")
while Gtk.events_pending():
    Gtk.main_iteration_do(False)
buf2 = win2.text_view.get_buffer()
buf2.select_range(buf2.get_start_iter(), buf2.get_start_iter())  # collapsed
subprocess.run(["wl-copy", "--clear"], capture_output=True)
e = Gdk.Event.new(Gdk.EventType.KEY_PRESS)
e.keyval = Gdk.KEY_c
e.state = Gdk.ModifierType.CONTROL_MASK
e.window = win2.get_window()
e.time = Gdk.CURRENT_TIME
win2.on_key(win2, e)
while Gtk.events_pending():
    Gtk.main_iteration_do(False)
check("a collapsed selection copies nothing",
      subprocess.run(["wl-paste", "--no-newline"], capture_output=True,
                     text=True, timeout=10).stdout.strip() == "")
win2.destroy()

print("\nthe copy button is gone")
def labels(w):
    out = []
    def walk(x):
        if isinstance(x, Gtk.Button):
            out.append(x.get_label())
        if isinstance(x, Gtk.Container):
            for ch in x.get_children():
                walk(ch)
    walk(w)
    return out
win3 = iw.Window("Footer", "x\n", "x", "text")
while Gtk.events_pending():
    Gtk.main_iteration_do(False)
check("no Copy all button", "Copy all" not in labels(win3), str(sorted(labels(win3))))
check("the size controls remain",
      all(k in labels(win3) for k in ("A−", "A+", "Reset", "Close")),
      str(sorted(labels(win3))))
win3.destroy()

iw.FONT_PREFS.unlink(missing_ok=True)
print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
sys.exit(1 if FAIL else 0)