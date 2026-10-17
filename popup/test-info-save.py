#!/usr/bin/env python3
"""
Save-to-file: the timestamped default, a chosen name, and the collision guard.

Exercises the writing path directly rather than through the dialog, because a
dialog needs a user. What is checked is the thing that can silently go wrong:
two saves of the same title in the same second, where an untimestamped name
would destroy the first copy.
"""

import importlib.machinery
import importlib.util
import re
import sys
import tempfile
from pathlib import Path

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Gtk  # noqa: E402

SCRIPT = Path.home() / ".local" / "bin" / "info-window"

spec = importlib.util.spec_from_loader(
    "iw", importlib.machinery.SourceFileLoader("iw", str(SCRIPT))
)
iw = importlib.util.module_from_spec(spec)
sys.modules["iw"] = iw
spec.loader.exec_module(iw)

PASS, FAIL = [], []
tmp = Path(tempfile.mkdtemp(prefix="iw-save-"))
iw.FONT_PREFS = tmp / "font-size"


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  {'ok  ' if cond else 'FAIL'}  {name}{'  — ' + detail if detail else ''}")


print("\nthe generated name is slugged and timestamped")
name = iw.save_filename("Build Report 2026/10", ".md")
check("it ends in the suffix", name.endswith(".md"), name)
check("punctuation became dashes", "Build-Report-2026-10" in name, name)
check("it carries a YYYYMMDD-HHMMSS stamp",
      bool(re.search(r"-\d{8}-\d{6}\.md$", name)), name)

print("\nthe generated name cannot collide")
# Interleaved, because that is what actually happens: a name is chosen, the
# file is written, the next one is chosen. Generating three up front finds
# nothing on disk to step around, which is correct -- there is nothing there.
made = []
for _ in range(3):
    got = iw.save_filename("Same title", ".txt", tmp)
    made.append(got)
    (tmp / got).write_text("x")
check("three saves in one second give three different names",
      len(set(made)) == 3, str(made))
after = iw.save_filename("Same title", ".txt", tmp)
check("and the next one steps around all of them",
      after not in made, f"{after} vs {made}")
# Compare against the first name directly. Regex cannot do this: the timestamp
# is itself all digits, so "-(\d+)\.txt$" matches the timestamp on the first
# name and the counter on the others.
first = made[0][:-len(".txt")]
check("the second and third append -2 and -3 to the first",
      made[1] == f"{first}-2.txt" and made[2] == f"{first}-3.txt", str(made))
check("without a directory the name is stable and unguarded",
      iw.save_filename("x", ".txt") == iw.save_filename("x", ".txt"),
      "documented: no existence check is possible without one")

print("\nan empty or punctuation-only title still yields a name")
for title, label in (("", "empty"), ("///", "slashes only"), ("   ", "spaces")):
    got = iw.save_filename(title, ".txt")
    check(f"{label} title -> a usable name",
          got.startswith("info-window-") and got.endswith(".txt"), got)

print("\nwriting to an explicit path")
win = iw.Window("Report", "line one\nline two\n", "memory", "text",
                font_size=11)
while Gtk.events_pending():
    Gtk.main_iteration_do(False)

target = tmp / "chosen-name.md"
written = win._on_save(str(target))
check("it reports the path it wrote", written == str(target), str(written))
check("the file exists", target.exists())
check("the contents are the source, verbatim",
      target.read_text() == "line one\nline two\n",
      repr(target.read_text()[:40]))
check("the status names the path", "Saved" in win.status.get_text(),
      win.status.get_text())

print("\na second save to the same path overwrites only when asked")
target.write_text("PREVIOUS CONTENT THAT MATTERED\n")
win._on_save(str(target))
check("the direct path write did replace it",
      "line one" in target.read_text(), repr(target.read_text()[:30]))

print("\nsuffix follows the format, not the extension asked for")
md = iw.Window("Doc", "# Heading\n", "memory", "markdown", font_size=11)
while Gtk.events_pending():
    Gtk.main_iteration_do(False)
md_path = tmp / "doc.md"
written = md._on_save(str(md_path))
check("markdown saves .md", written.endswith(".md"), str(written))
check("and writes the markdown source, not rendered HTML",
      md_path.read_text() == "# Heading\n", repr(md_path.read_text()[:40]))

print("\na bad path is reported, not raised")
before = win.status.get_text()
check("an unwritable path returns None",
      win._on_save("/proc/definitely/not/writable/x.txt") is None)
check("and says so in the status", "Could not write" in win.status.get_text(),
      win.status.get_text())

print("\nno file was created for the failed attempt")
check("nothing landed in the impossible directory",
      not Path("/proc/definitely/not/writable/x.txt").exists())

print("\nthe Save button is in the footer")
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
btns = labels(win)
check("Save exists", "Save" in btns, str(sorted(btns)))
check("and the size controls are still there",
      all(k in btns for k in ("A−", "A+", "Reset", "Close")), str(sorted(btns)))
check("no Copy all came back", "Copy all" not in btns, str(sorted(btns)))

md.destroy()
win.destroy()
iw.FONT_PREFS.unlink(missing_ok=True)
import shutil
shutil.rmtree(tmp, ignore_errors=True)
print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
sys.exit(1 if FAIL else 0)