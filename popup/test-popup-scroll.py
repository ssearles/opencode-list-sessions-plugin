#!/usr/bin/env python3
"""
Does the popup survive more sessions than fit on screen?

The question is whether the scrolling is real rather than assumed: seed a
throwaway database with many more sessions than the window can show, open the
window, and ask GTK whether the list is actually taller than its viewport.

Never run against the real database.
"""

import importlib.machinery
import importlib.util
import os
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path

import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gtk  # noqa: E402

SCRIPT = Path.home() / ".local" / "bin" / "session-list-popup"
REAL = Path.home() / ".local" / "share" / "opencode" / "opencode.db"
N = int(os.environ.get("N", "300"))

spec = importlib.util.spec_from_loader(
    "pop", importlib.machinery.SourceFileLoader("pop", str(SCRIPT))
)
pop = importlib.util.module_from_spec(spec)
sys.modules["pop"] = pop
spec.loader.exec_module(pop)

PASS, FAIL = [], []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  {'ok  ' if cond else 'FAIL'}  {name}{'  — ' + detail if detail else ''}")


tmp = Path(tempfile.mkdtemp(prefix="popup-many-"))
db = tmp / "opencode.db"
c = sqlite3.connect(REAL)
c.execute("VACUUM INTO ?", (str(db),))
c.close()

c = sqlite3.connect(db)
donor = c.execute(
    "SELECT id, directory, project_id FROM session_v2 LIMIT 1").fetchone()
# Copy every column from the donor and override only the ones that identify the
# row. The live schema has several NOT NULL columns that differ per release, so
# naming them would break the test on the next version.
donor_row = c.execute(f"SELECT * FROM {pop.Store(db).table} WHERE id = ?", (donor[0],)).fetchone()
cols = [d[0] for d in c.execute(f"SELECT * FROM {pop.Store(db).table} LIMIT 0").description]
sql = (f"INSERT INTO {pop.Store(db).table} ({','.join(cols)}) "
       f"VALUES ({','.join('?' * len(cols))})")
rows = []
for i in range(N):
    vals = list(donor_row)
    vals[cols.index("id")] = f"ses_filler{i:04d}"
    vals[cols.index("title")] = f"Filler session number {i:04d} zzz"
    rows.append(tuple(vals))
c.executemany(sql, rows)
c.commit()
total = c.execute("SELECT COUNT(*) FROM session_v2").fetchone()[0]
c.close()
print(f"seeded {N} sessions; table now holds {total}")

store = pop.Store(db)
win = pop.Window(store)
win.set_default_size(664, 614)
win.show_all()
while Gtk.events_pending():
    Gtk.main_iteration_do(False)

rows_shown = len([r for r in win.listbox.get_children()
                  if isinstance(r, Gtk.ListBoxRow)
                  and not getattr(r, "is_section", False)])
check(f"all {total} sessions are in the listbox", rows_shown == total,
      f"{rows_shown} rows")

scrollers = []
def walk(w):
    if isinstance(w, Gtk.ScrolledWindow):
        scrollers.append(w)
    if isinstance(w, Gtk.Container):
        for ch in w.get_children():
            walk(ch)
walk(win)
check("a ScrolledWindow exists", len(scrollers) == 1, f"{len(scrollers)} found")

if scrollers:
    sc = scrollers[0]
    hadj, vadj = sc.get_hadjustment(), sc.get_vadjustment()
    viewport = sc.get_child()
    upper = vadj.get_upper()
    page = vadj.get_page_size()
    print(f"\n  viewport {viewport.get_allocated_height()}px, "
          f"content {upper:.0f}px, page {page:.0f}px")
    check("the content is taller than the viewport", upper > page,
          f"content {upper:.0f} vs page {page:.0f}")
    check("a vertical scrollbar is visible", vadj.get_page_size() < vadj.get_upper())
    check("the adjustment can actually scroll",
          vadj.get_value() == vadj.get_lower()
          and vadj.get_value() < vadj.get_upper(),
          f"value={vadj.get_value():.0f} lower={vadj.get_lower():.0f}")

    # Scroll to the bottom and confirm the last session is reachable.
    vadj.set_value(vadj.get_upper() - vadj.get_page_size())
    while Gtk.events_pending():
        Gtk.main_iteration_do(False)
    # Highest filler number, which also sorts last alphabetically because of the
    # trailing "zzz".
    last = f"Filler session number {N - 1:04d} zzz"
    titles = []
    for r in win.listbox.get_children():
        if isinstance(r, Gtk.ListBoxRow) and not getattr(r, "is_section", False):
            found = []
            def labels_in(w, out):
                if isinstance(w, Gtk.Label):
                    t = (w.get_text() or "").strip()
                    if t:
                        out.append(t)
                if isinstance(w, Gtk.Container):
                    for ch in w.get_children():
                        labels_in(ch, out)
                return out
            labels_in(r, found)
            if found:
                titles.append(found[0])
    check("the alphabetically last session is in the list", last in titles,
          f"looking for {last!r}")

print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
shutil.rmtree(tmp, ignore_errors=True)
sys.exit(1 if FAIL else 0)