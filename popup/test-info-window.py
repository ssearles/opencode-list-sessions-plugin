#!/usr/bin/env python3
"""
Prove the text-size control works, without needing a keyboard.

The Ctrl + +/- shortcuts themselves need a real key event on a focused window,
which cannot be synthesised here, so those are the user's to verify. Everything
underneath them is checkable: the provider applies, the size clamps, the value
persists and survives a restart, and a corrupt saved value falls back rather
than crashing the window.
"""

import importlib.machinery
import importlib.util
import sys
from pathlib import Path

import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gtk  # noqa: E402

SCRIPT = Path.home() / ".local" / "bin" / "info-window"

spec = importlib.util.spec_from_loader(
    "iw", importlib.machinery.SourceFileLoader("iw", str(SCRIPT))
)
iw = importlib.util.module_from_spec(spec)
sys.modules["iw"] = iw
spec.loader.exec_module(iw)

PASS, FAIL = [], []


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


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  {'ok  ' if cond else 'FAIL'}  {name}{'  — ' + detail if detail else ''}")


# Redirect the prefs file so this run cannot disturb the real setting.
iw.FONT_PREFS = Path("/tmp/opencode/font-size-test")

print("\nthe window opens and exposes a text view")
win = iw.Window("Probe", "alpha\nbeta\ngamma\n", "probe", "text",
                font_size=iw.FONT_DEFAULT)
while Gtk.events_pending():
    Gtk.main_iteration_do(False)
check("a TextView was built", win.text_view is not None)
check("no WebKit view in text mode", win.webview is None)
check("it starts at the size asked for",
      win.font_size == iw.FONT_DEFAULT, str(win.font_size))

print("\nresizing")
win.set_font_size(19)
while Gtk.events_pending():
    Gtk.main_iteration_do(False)
check("font_size follows the call", win.font_size == 19, str(win.font_size))

print("\nit clamps at both ends")
win.set_font_size(9999)
check("the ceiling holds", win.font_size == iw.FONT_MAX, str(win.font_size))
win.set_font_size(-4)
check("the floor holds", win.font_size == iw.FONT_MIN, str(win.font_size))

print("\nthe size is written where the next window will find it")
win.set_font_size(17)
check("the prefs file exists", iw.FONT_PREFS.exists())
check("it holds what was set",
      iw.FONT_PREFS.read_text().strip() == "17",
      iw.FONT_PREFS.read_text().strip())
check("load_font_size reads it back", iw.load_font_size() == 17,
      str(iw.load_font_size()))

print("\na second window starts where the first was left")
win2 = iw.Window("Probe 2", "x\n", "probe2", "text",
                 font_size=iw.load_font_size())
while Gtk.events_pending():
    Gtk.main_iteration_do(False)
check("it inherits the saved size", win2.font_size == 17, str(win2.font_size))
win2.destroy()

print("\na corrupt or missing prefs file falls back instead of failing")
for bad, label in ((None, "missing"), ("not-a-number", "garbage"),
                   ("", "empty"), ("999", "out of range"), ("-5", "negative")):
    if bad is None:
        iw.FONT_PREFS.unlink(missing_ok=True)
    else:
        iw.FONT_PREFS.write_text(bad)
    got = iw.load_font_size()
    ok = iw.FONT_MIN <= got <= iw.FONT_MAX
    check(f"{label} prefs -> a usable size", ok, f"got {got}")

print("\nthe status line names the size")
iw.FONT_PREFS.write_text("17\n")
win3 = iw.Window("Probe 3", "y\n", "probe3", "text", font_size=17)
while Gtk.events_pending():
    Gtk.main_iteration_do(False)
check("the footer has visible size controls",
      all(k in labels(win3) for k in ("A\u2212", "A+", "Reset")),
      str(sorted(labels(win3))))
win3.destroy()
win.destroy()

iw.FONT_PREFS.unlink(missing_ok=True)
print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
sys.exit(1 if FAIL else 0)