#!/usr/bin/env python3
"""
Drive the popup's GTK widgets headlessly against a throwaway database.

X/OpenCode is never involved: the window is built, rows are clicked, and the
Archive button is pressed, so the wiring a screenshot cannot show is what gets
tested. Never run against the real database.
"""

import re
import datetime
import importlib.machinery
import importlib.util
import os
import shutil
import sqlite3
import sys
import tempfile
import time
from pathlib import Path

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Gdk, GLib, Gtk  # noqa: E402

REAL = Path.home() / ".local" / "share" / "opencode" / "opencode.db"

# The popup under test. Defaults to this repo's copy so the suite tests what is
# committed rather than whatever happens to be installed in ~/.local/bin;
# override with SESSION_POPUP when testing an installed build specifically.
SCRIPT = Path(
    os.environ.get("SESSION_POPUP")
    or Path(__file__).resolve().parent / "session-list-popup"
)

spec = importlib.util.spec_from_loader(
    "pop", importlib.machinery.SourceFileLoader("pop", str(SCRIPT))
)
pop = importlib.util.module_from_spec(spec)
sys.modules["pop"] = pop          # so the window's globals are patchable
spec.loader.exec_module(pop)

PASS, FAIL = [], []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  {'ok  ' if cond else 'FAIL'}  {name}{'  — ' + detail if detail else ''}")


def click(widget, button=1):
    """Synthesise a click on a widget's centre."""
    # A list row has no GdkWindow of its own. Real presses land on the listbox,
    # which resolves the row from the pointer position, so the event is sent
    # there with the row's own allocation as the coordinates.
    target = (widget.get_parent()
              if isinstance(widget, Gtk.ListBoxRow) else widget)
    # A reload() rebuilds the rows, and they have no allocation until GTK has
    # run a frame; without this the click lands on whatever was at (0, 0).
    while Gtk.events_pending():
        Gtk.main_iteration_do(False)
    a = widget.get_allocation()
    event = Gdk.Event.new(Gdk.EventType.BUTTON_PRESS)
    event.button = button
    event.x, event.y = float(a.x + a.width // 2), float(a.y + a.height // 2)
    event.time = Gdk.CURRENT_TIME
    target.emit("button-press-event", event)
    while Gtk.events_pending():
        Gtk.main_iteration_do(False)


def seed_session(db, session_id, title, offset=1):
    """
    Add one deterministic, unarchived session to the throwaway copy.

    The filter and write checks name a session ("popup feedback") that existed
    on the machine this suite was written on. A real database is not a fixture:
    on a machine that never ran those sessions the checks failed for a reason
    that had nothing to do with the code under test.
    """
    c = sqlite3.connect(db)
    c.row_factory = sqlite3.Row
    try:
        donor = c.execute(
            "SELECT * FROM session_v2 ORDER BY time_updated DESC LIMIT 1"
        ).fetchone()
        if donor is None:
            return
        row = dict(donor)
        oldest = c.execute("SELECT MIN(time_updated) FROM session_v2").fetchone()[0]
        stamp = (oldest or 0) - offset
        row.update(
            id=session_id,
            slug=title.replace(" ", "-"),
            title=title,
            time_created=stamp,
            time_updated=stamp,
            time_archived=None,
            time_suspended=None,
        )
        c.execute(
            f"INSERT INTO session_v2 ({', '.join(row)}) "
            f"VALUES ({', '.join('?' for _ in row)})",
            tuple(row.values()),
        )
        c.commit()
    finally:
        c.close()


def archived_ids(db):
    c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    out = {r[0] for r in c.execute(
        "SELECT id FROM session_v2 WHERE time_archived IS NOT NULL")}
    c.close()
    return out


def main():
    tmp = Path(tempfile.mkdtemp(prefix="popup-gui-"))
    real_before = archived_ids(REAL)
    try:
        db = tmp / "opencode.db"
        c = sqlite3.connect(REAL)
        c.execute("VACUUM INTO ?", (str(db),))
        c.close()
        seed_session(db, "ses_popupfeedback0000000000", "popup feedback")
        seed_session(db, "ses_secondpopup00000000000", "popup window review", 2)

        store = pop.Store(db)
        win = pop.Window(store)
        win.show_all()

        print("\nwindow builds")
        def session_rows(w):
            return [r for r in w.listbox.get_children()
                    if isinstance(r, Gtk.ListBoxRow)
                    and not getattr(r, "is_section", False)]

        rows = session_rows(win)
        check("session rows present", len(rows) >= 2, f"{len(rows)} rows")
        check("section headings excluded from session rows",
              len(rows) < len(win.listbox.get_children()))

        # Asserted before anything mutates the sort, because every later block
        # that needs an order clicks a button first.
        check("the window opens newest-first",
              win.sort_mode == pop.DEFAULT_SORT == "updated"
              and [b.get_label() for b in win.sort_buttons if b.get_active()]
              == ["Last modified"],
              f"{win.sort_mode} / "
              f"{[b.get_label() for b in win.sort_buttons if b.get_active()]}")

        print("\nstrips start hidden")
        check("no action strip visible at start",
              all(not r.actions.get_visible() for r in rows))

        print("\na left click reveals the strip -- that is the documented action")
        target = rows[0]
        check("no strip visible before the click",
              all(not r.actions.get_visible() for r in rows))
        click(target, button=1)
        check("clicked row's strip is visible", target.actions.get_visible())
        check("other rows' strips stay hidden",
              all(not r.actions.get_visible() for r in rows[1:]))

        print("\nright click also opens it, and re-selects the row")
        target2 = rows[2]
        click(target2, button=3)
        check("right-click opens that row's strip", target2.actions.get_visible())
        check("and only that row's", all(not r.actions.get_visible() for r in rows
                                         if r is not target2))

        print("\nleft-click on another row moves the strip")
        other = rows[1]
        click(other, button=1)
        check("new row's strip visible", other.actions.get_visible())
        check("previous row's strip hidden", not target.actions.get_visible())

        print("\nleft-click again closes it")
        click(other, button=1)
        check("strip toggled off", not other.actions.get_visible())

        print("\nthe switch and the row agree about which strip is open")
        # Opening a row turns the other rows' switches off. That must not
        # unselect the row just clicked: a strip that closes as it opens is
        # exactly what the old switch-only code did.
        first, second = rows[0], rows[1]
        first.switch.set_active(True)
        while Gtk.events_pending():
            Gtk.main_iteration_do(False)
        check("flipping a switch opens its row", first.actions.get_visible())
        click(second, button=1)
        check("clicking another row moves the strip",
              second.actions.get_visible()
              and not first.actions.get_visible(),
              str([r.actions.get_visible() for r in rows[:2]]))
        check("the first row's switch is off again",
              not first.switch.get_active())
        click(second, button=1)
        check("clicking the open row closes it",
              not second.actions.get_visible())

        print("\nno Refresh button, and focus re-reads the database")
        labels = []

        def walk(w):
            # get_children() raises on a widget with no children in some GTK
            # versions, so only recurse into containers that have any.
            if isinstance(w, Gtk.Button):
                labels.append(w.get_label())
            elif isinstance(w, Gtk.Container):
                for ch in w.get_children():
                    walk(ch)
        walk(win)
        check("Refresh button is gone", "Refresh" not in labels, str(labels))
        # Not "Close": each row's strip now has its own Close that only backs
        # out of the strip, and two identically-named buttons on one screen is
        # how the wrong one gets pressed.
        check("the window button is named Close window",
              "Close window" in labels, str(labels))

        # A write made behind this window's back -- by the agent, the plugin or
        # OpenCode's own UI -- must show up when it takes focus again. That is
        # the disagreement this was reported as.
        blind = session_rows(win)[0]
        db_g = sqlite3.connect(db)
        try:
            db_g.execute(
                f"UPDATE {store.table} SET time_archived = 1 WHERE id = ?",
                (blind.session_id,),
            )
            db_g.commit()
        finally:
            db_g.close()
        print("\nno row numbers anywhere")
        # The numbers were a leftover from the numbered-text-menu era. Every
        # action is a click now, so a number in front of a row was a position
        # the user had to read and could not use -- and one that archiving
        # invalidated immediately, since the session jumps sections.
        def labels_in(w, out):
            if isinstance(w, Gtk.Label):
                t = (w.get_text() or "").strip()
                if t:
                    out.append(t)
            if isinstance(w, Gtk.Container):
                for ch in w.get_children():
                    labels_in(ch, out)
            return out

        row_labels = []
        for r in session_rows(win)[:3]:
            row_labels.extend(labels_in(r, []))
        check("no bare-number label in any row",
              not [t for t in row_labels if t.isdigit()],
              str([t for t in row_labels if t.isdigit()][:5]))
        check("no 'Row N' prefix on a strip",
              not [t for t in row_labels if t.startswith("Row ")],
              str([t for t in row_labels if t.startswith("Row ")][:5]))
        check("no badge class left in the source",
              "badge" not in Path(SCRIPT).read_text())

        check("window still shows it as unarchived before the focus event",
              any(r.session_id == blind.session_id for r in session_rows(win)
                  if "ARCHIVED" not in _chips(r)))

        # focus-in deliberately does NOT reload. It used to, and because reload()
        # ends in show_all() -- which can shift focus, which fires focus-in
        # again -- that was a feedback loop which showed as continuous blinking.
        focus_calls = []
        real_reload_focus = win.reload
        win.reload = lambda: (focus_calls.append(1), real_reload_focus())[1]
        try:
            for _ in range(20):
                # Call the handler rather than emitting the signal: GTK
                # dereferences the event argument inside focus-in-event and
                # segfaults when it is None.
                win._on_focus_in()
                while Gtk.events_pending():
                    Gtk.main_iteration_do(False)
        finally:
            win.reload = real_reload_focus
        check("20 focus-ins cause zero reloads", focus_calls == [],
              f"{len(focus_calls)} reloads - this is the blinking loop")

        # Put it back so the remaining tests start from a known state.
        db_g = sqlite3.connect(db)
        try:
            db_g.execute(
                f"UPDATE {store.table} SET time_archived = NULL WHERE id = ?",
                (blind.session_id,),
            )
            db_g.commit()
        finally:
            db_g.close()
        win.reload()
        rows = session_rows(win)

        print("\nclicking Name sorts by name, not by recency")
        # This block used to assert the window's *default* was alphabetical,
        # which is why it could skip clicking anything. The default is now
        # newest-first, so the button is clicked here and the block keeps
        # testing what it was written to test: that by_name is what orders the
        # rows, and that no timestamp leaks into the key.
        next(b for b in win.sort_buttons
             if b.get_label() == "Name").set_active(True)
        def titles_on_screen(w):
            """(section heading, title) for each session row, in display order."""
            out = []
            section = None
            for r in w.listbox.get_children():
                if not isinstance(r, Gtk.ListBoxRow):
                    continue
                if getattr(r, "is_section", False):
                    found = []
                    labels_in(r, found)
                    section = found[0] if found else ""
                    continue
                found = []
                labels_in(r, found)
                # The title is the first label; the id and meta follow.
                out.append((section, found[0] if found else ""))
            return out

        # No reload here. The window was reloaded by the block above, after the
        # blind-write row was put back, so its grouping is genuinely fresh --
        # comparing it against a live read of the database is a fair test of
        # sort order rather than of staleness.
        on_screen = titles_on_screen(win)

        # Compared per section, not as one list. The window groups
        # unarchived-then-archived, so an archived session sorts after every
        # unarchived one regardless of its title. An earlier version sorted the
        # whole list together and failed the moment the real database held an
        # archived session -- a fault in the test, not the window.
        #
        # Only the first word of each heading is compared. The rest of the
        # heading is wording, and this suite tests behaviour; restating the full
        # sentence here meant every copy edit to the heading broke a sort check.
        all_rows = store.list()

        def group(word, rows):
            return [(word, d["title"] or "(untitled)") for d in rows]

        want = group("UNARCHIVED", pop.by_name(
            [d for d in all_rows if not d["archived"]]))
        want += group("ARCHIVED", pop.by_name(
            [d for d in all_rows if d["archived"]]))
        got = [((s or "").split(" ")[0], t) for s, t in on_screen]
        check("screen order matches by_name() within each section",
              got == want,
              f"screen {got} vs expected {want}")
        check("sections are grouped unarchived then archived",
              [s for s, _ in got] == sorted(
                  [s for s, _ in got],
                  key=lambda s: 0 if s == "UNARCHIVED" else 1),
              str([s for s, _ in got]))
        for section in {s for s, _ in got if s}:
            lower = [t.lower() for sec, t in got
                     if sec == section and t != "(untitled)"]
            check(f"{section} titles are alphabetical",
                  lower == sorted(lower), str(lower))
        check("untitled rows would sort last, not first",
              pop.by_name([
                  {"title": None, "id": "b"},
                  {"title": "Zebra", "id": "c"},
                  {"title": "apple", "id": "a"},
              ])[0]["id"] == "a",
              "untitled took the top slot")
        check("by_name is case-insensitive",
              [d["title"] for d in pop.by_name([
                  {"title": "Banana", "id": "2"},
                  {"title": "apple", "id": "1"},
              ])] == ["apple", "Banana"])
        check("by_name is stable for duplicate titles",
              [d["id"] for d in pop.by_name([
                  {"title": "Same", "id": "z"},
                  {"title": "Same", "id": "a"},
              ])] == ["a", "z"])

        print("\nthree sort orders, one of them active")
        def sort_btn(label):
            return next((b for b in win.sort_buttons if b.get_label() == label), None)

        check("three sort buttons exist", len(win.sort_buttons) == 3,
              str([b.get_label() for b in win.sort_buttons]))
        check("they are labelled Name, Start date and Last modified",
              [b.get_label() for b in win.sort_buttons]
              == ["Name", "Start date", "Last modified"],
              str([b.get_label() for b in win.sort_buttons]))
        # Without a shared group each button is its own group and all three
        # read as selected at once, which is the PyGObject trap the radio
        # buttons were built to avoid.
        #
        # get_group() comes back as a list in this binding, not a RadioButton,
        # so the group is identified by its leader rather than compared.
        leaders = {id(g[0]) if len(g) else None
                   for g in (b.get_group() for b in win.sort_buttons)}
        check("they share one radio group", len(leaders) == 1, str(leaders))
        check("the open order is one of the three",
              win.sort_mode in {m for m, _l, _f, _d in pop.SORTS},
              win.sort_mode)

        rows_now = store.list()
        want_by = {
            "name": pop.by_name,
            "created": lambda r: pop.by_date(r, "time_created"),
            "updated": lambda r: pop.by_date(r, "time_updated"),
        }

        def screen_order():
            """Screen order as (section-first-word, title), archive state intact."""
            return [((s or "").split(" ")[0], t) for s, t in titles_on_screen(win)]

        for mode, label, _field, _desc in pop.SORTS:
            sort_btn(label).set_active(True)
            expected = []
            for word, subset in (
                ("UNARCHIVED", [d for d in rows_now if not d["archived"]]),
                ("ARCHIVED", [d for d in rows_now if d["archived"]]),
            ):
                if not subset:
                    continue
                expected += [(word, d["title"] or "(untitled)")
                             for d in want_by[mode](subset)]
            got = screen_order()
            check(f"screen is ordered by {label}", got == expected,
                  f"got {got} want {expected}")
            check(f"{label} leaves exactly one button active",
                  sum(1 for b in win.sort_buttons if b.get_active()) == 1)
            check(f"the footer names the {label} order",
                  pop.SORTS[[o[0] for o in pop.SORTS].index(mode)][3]
                  in (win.status.get_text() or ""),
                  win.status.get_text())

        # The two date orders must genuinely differ from each other and from
        # name order, or the assertions above pass on a list that ignores the
        # field it was handed.
        name_order = screen_order()
        sort_btn("Start date").set_active(True)
        start_order = screen_order()
        sort_btn("Last modified").set_active(True)
        mod_order = screen_order()
        check("start-date and last-modified orders differ from each other",
              start_order != mod_order, "both produced the same order")
        check("name order is not accidentally a date order",
              len({str(name_order), str(start_order), str(mod_order)}) >= 2,
              str(name_order))

        sort_btn("Name").set_active(True)
        check("sorting back to Name works", win.sort_mode == "name")

        print("\nthe search box filters, and keeps every keystroke")

        def settle():
            """Run the main loop until the debounced filter has been applied.

            Gtk.SearchEntry emits search-changed from a ~150ms timer rather
            than from the keystroke, so a test that only calls set_text() never
            sees the filter run -- and then "passes" every check below while
            really only measuring a window with no filter on it. That is not a
            hypothetical: it is exactly what the first run of this block did.
            """
            want = win.search.get_text()
            ctx = GLib.MainContext.default()
            deadline = time.time() + 2.0
            while time.time() < deadline:
                while ctx.pending():
                    ctx.iteration(False)
                if win.query == want:
                    return True
                time.sleep(0.005)
            return False

        def type_in_search(text):
            win.search.set_text(text)
            return settle()

        def m_term(path):
            """The words a folder name contributes to a search, lowercased.

            Spaced folder names become two search terms, which is exactly what
            filter_rows() turns them into -- so the expectation has to be built
            the same way or it compares two different rules.
            """
            return [t for t in path.rsplit("/", 1)[-1].lower().split() if t]

        # Typed one character at a time on purpose. reload() rebuilds the list
        # on every change, and the failure this guards is focus being taken by
        # the rebuilt list -- after which the second character goes nowhere and
        # the box silently holds a prefix of what was typed.
        for ch in "popup":
            win.search.set_text(win.search.get_text() + ch)
        check("every keystroke is still in the box",
              win.search.get_text() == "popup", win.search.get_text())
        check("the debounced filter ran", settle())
        check("the window's own filter state matches the box",
              win.query == "popup", repr(win.query))

        for q in ("popup", "job", "NOPE-NO-SUCH-ANYWHERE"):
            check(f"filter {q!r} applied", type_in_search(q))
            shown = sorted(t for _s, t in screen_order())
            expect = sorted(d["title"] or "(untitled)"
                            for d in pop.filter_rows(rows_now, q))
            check(f"filter {q!r} shows exactly the matching rows",
                  shown == expect, f"got {shown} want {expect}")

        type_in_search("popup")
        check("a one-word filter narrows the list",
              len(screen_order()) < len(rows_now),
              f"{len(screen_order())} of {len(rows_now)}")

        print("\nthe search covers id and folder, not just the title")
        owner = next(d for d in rows_now if d["title"])
        type_in_search(owner["id"][:12])
        check("an id fragment finds its own session",
              [t for _s, t in screen_order()] == [owner["title"]],
              str(screen_order()))

        folder = rows_now[0]["directory"]
        type_in_search(folder.rsplit("/", 1)[-1])
        check("a folder name finds sessions from it",
              len(screen_order()) >= 1, str(screen_order()))
        check("and finds every session in that folder",
              len(screen_order())
              == sum(1 for d in rows_now
                     if m_term(folder)
                     and all(t in (d["title"] + d["id"] + d["directory"]).lower()
                             for t in m_term(folder))),
              str(screen_order()))

        print("\nwords are combined, not alternated")
        type_in_search("popup feedback")
        check("both words present matches one session",
              len(screen_order()) == 1, str(screen_order()))
        type_in_search("popup zzzz-no-such-word")
        check("one matching and one missing word matches nothing",
              screen_order() == [], str(screen_order()))

        print("\nno matches says so, rather than showing a blank list")
        type_in_search("zzz-no-such-word")
        texts = []
        for child in win.listbox.get_children():
            if isinstance(child, Gtk.ListBoxRow):
                found = []
                labels_in(child, found)
                texts += found
        check("it names the term that found nothing",
              any("zzz-no-such-word" in t for t in texts), str(texts))
        check("and says how many are hidden",
              any(str(len(rows_now)) in t for t in texts), str(texts))
        # A bare widget added to a ListBox is wrapped in a row of its own, and
        # an unmarked row is a session to everything downstream: it lands in the
        # totals, and right-clicking it opens a strip for a session that does
        # not exist.
        check("the no-match message is not a session row",
              len(session_rows(win)) == 0, f"{len(session_rows(win))} rows")
        check("the footer counts what is shown",
              f"0 of {len(rows_now)}" in (win.status.get_text() or ""),
              win.status.get_text())

        print("\nEsc in the search box clears it, not the window")
        type_in_search("popup")
        ev = Gdk.Event.new(Gdk.EventType.KEY_PRESS)
        ev.keyval = Gdk.KEY_Escape
        win.emit("key-press-event", ev)
        check("the box is empty", win.search.get_text() == "",
              win.search.get_text())
        check("the window is still open", win.get_visible())
        settle()
        check("the full list is back", len(screen_order()) == len(rows_now),
              f"{len(screen_order())} of {len(rows_now)}")

        print("\nthe filter and the order survive a write")
        # "popup" rather than "job" because the Job 8 sessions are archived,
        # and the point here is a write, so it needs a row that can be written.
        type_in_search("popup")
        sort_btn("Last modified").set_active(True)
        visible = [r for r in session_rows(win)
                   if "ARCHIVED" not in _chips(r)
                   and "THIS SESSION" not in _chips(r)]
        target = visible[0] if visible else None
        check("the filter left an archivable row to act on", target is not None,
              str([c for r in session_rows(win) for c in _chips(r)
                   if c in ("ARCHIVED", "THIS SESSION")]))
        if target is not None:
            click(target, button=1)
            strip = _find_buttons(target.actions)
            check("that row could be archived",
                  "Archive" in strip and strip["Archive"].get_sensitive(),
                  str(list(strip)))
            if "Archive" in strip and strip["Archive"].get_sensitive():
                click(strip["Archive"])
                check("the filter is still applied after archiving",
                      win.search.get_text() == "popup", win.search.get_text())
                check("the order is still last-modified after archiving",
                      win.sort_mode == "updated", win.sort_mode)
                check("the search box still holds what was typed",
                      win.search.get_text() == win.query, repr(win.query))

        print("\nfiltering does not unprotect the live session")
        type_in_search("")
        sort_btn("Name").set_active(True)
        victim = session_rows(win)[0]
        db_g = sqlite3.connect(db)
        try:
            db_g.execute(f"UPDATE {store.table} SET time_suspended = NULL")
            db_g.execute(
                f"UPDATE {store.table} SET time_suspended = ? WHERE id = ?",
                (int(datetime.datetime.now().timestamp() * 1000),
                 victim.session_id),
            )
            db_g.commit()
        finally:
            db_g.close()
        type_in_search(victim.session_id[:10])
        live_rows = [r for r in session_rows(win)
                     if r.session_id == victim.session_id]
        check("the live row survived the filter", bool(live_rows),
              "filtering hid the session it marked")
        if live_rows:
            lr = live_rows[0]
            click(lr, button=1)
            btns = _find_buttons(lr.actions)
            check("Archive is still disabled on the live row while filtering",
                  "Archive" in btns and not btns["Archive"].get_sensitive(),
                  str(list(btns)))

        # Left as the later blocks expect: no filter, default order.
        type_in_search("")
        sort_btn(next(o[1] for o in pop.SORTS if o[0] == pop.DEFAULT_SORT)
                ).set_active(True)
        check("the window is back to its default view",
              win.query == "" and win.sort_mode == pop.DEFAULT_SORT
              and len(screen_order()) == len(rows_now),
              f"{win.query!r} / {win.sort_mode}")

        print("\n--copy prints the same order the window opens on")
        # Both read DEFAULT_SORT rather than repeating the choice, so this is a
        # check on the constant being honoured twice, not on two sorters
        # agreeing by luck. Compared against the window's own order rather than
        # a sort rebuilt here: both order each *section* separately, so a flat
        # sort of every row is a third thing and disagrees with both.
        text_out = pop.plain_text(store)
        on_screen_now = [t for _s, t in screen_order()]
        positions = [text_out.find(t) for t in on_screen_now]
        check("--copy lists every row the window lists",
              all(p != -1 for p in positions),
              f"{sum(1 for p in positions if p == -1)} missing from --copy")
        check("--copy is in the same order as the window",
              positions == sorted(positions),
              f"{[(t, p) for t, p in zip(on_screen_now, positions) if p == -1]}")

        print("\nthe sort buttons describe themselves truthfully")
        # The tooltip says which order the window reopens in, and it was written
        # by hand as "Name" -- then went on saying so for three commits after the
        # default became newest-first. A tooltip that contradicts the window is
        # worse than no tooltip, so the sentence is checked against the constant
        # rather than trusted.
        for b in win.sort_buttons:
            tip = b.get_tooltip_text() or ""
            check(f"the {b.get_label()} tooltip names the real default",
                  pop.DEFAULT_SORT_LABEL in tip and "resets to" in tip,
                  tip.replace("\n", " ")[:70])
        check("the default label is the mode the window opens on",
              pop.DEFAULT_SORT == "updated"
              and pop.DEFAULT_SORT_LABEL == "Last modified",
              f"{pop.DEFAULT_SORT} / {pop.DEFAULT_SORT_LABEL}")

        print("\ncontent fits a half-width tile")
        # Use preferred widths, not allocations: this window is never mapped in
        # the test, so every allocation is 1px and measuring one proves nothing.
        # get_preferred_width() is the widget's natural demand, which is exactly
        # what overflows a tile.
        TILE = 664  # half of this 1366px screen, which is what Hyprland gives us

        row = session_rows(win)[0]
        click(row, button=1)
        while Gtk.events_pending():
            Gtk.main_iteration_do(None)

        btns = _find_buttons(row.actions)
        expected = ("Archive", "Stats", "Transcript.md", "Export.json",
                    "Delete", "Close")
        check("every button exists on an unarchived row",
              all(k in btns for k in expected),
              f"missing {[k for k in expected if k not in btns]} in {list(btns)}")

        buttons_natural = max(b.get_preferred_width()[0] for b in btns.values())
        strip_natural = row.actions.get_preferred_width()[0]
        check("buttons alone fit the tile",
              buttons_natural <= TILE,
              f"buttons want {buttons_natural}px, tile is {TILE}px")

        # The FlowBox is what makes this true: it wraps rather than demanding
        # the sum of its children. Assert it is actually a FlowBox, because the
        # width property is only meaningful with wrapping enabled.
        flows = [w for w in _all_widgets(row.actions) if isinstance(w, Gtk.FlowBox)]
        check("buttons live in a wrapping container", len(flows) == 1)
        if flows:
            flow = flows[0]
            check("wrapping is enabled on it",
                  flow.get_max_children_per_line() > 0,
                  str(flow.get_max_children_per_line()))

        # Six buttons have to land in at most two lines, or the strip grows
        # taller than the tile is wide and the third line is what pushes the
        # buttons off a half-width window.
        check("six buttons fit in two lines",
              len(expected) <= 2 * flows[0].get_max_children_per_line(),
              f"{len(expected)} buttons, "
              f"{flows[0].get_max_children_per_line()} per line")

        check("the label ellipsizes rather than forcing width",
              _strip_label_widget(row.actions).get_ellipsize()
              is not None,
              "no ellipsize set on the action label")

        print(f"      strip natural width {strip_natural}px vs tile {TILE}px")

        print("\nno resync code remains in the popup")
        # The rename-based resync was removed: it was verified twice against
        # the real server and the app never applied it. The desktop app caches
        # its session list and no event re-fetches it, so the popup now states
        # the restart requirement in its own banner instead of pretending to
        # push changes across.

        src = Path(SCRIPT).read_text()
        for gone in ("request_resync", "service_endpoint", "_resync_changed",
                     "_on_close"):
            check(f"{gone} is gone", gone not in src)

        print("\nthe live session is protected in the UI")
        # Mark a row the way the desktop app marks the active session.
        victim = session_rows(win)[0]
        db_g = sqlite3.connect(db)
        try:
            db_g.execute(
                f"UPDATE {store.table} SET time_suspended = ? WHERE id = ?",
                (int(datetime.datetime.now().timestamp() * 1000), victim.session_id),
            )
            db_g.commit()
        finally:
            db_g.close()
        win.reload()

        live_row = next(r for r in session_rows(win)
                        if r.session_id == victim.session_id)
        click(live_row, button=1)
        strip_btns = _find_buttons(live_row.actions)
        check("Archive button exists but is disabled",
              "Archive" in strip_btns and not strip_btns["Archive"].get_sensitive(),
              str(list(strip_btns)))
        check("Delete button exists but is disabled",
              "Delete" in strip_btns and not strip_btns["Delete"].get_sensitive(),
              str(list(strip_btns)))
        check("the rest stay available on the live row",
              all(strip_btns[k].get_sensitive()
                  for k in ("Stats", "Transcript.md", "Export.json", "Close")
                  if k in strip_btns))
        check("the strip says archiving is not allowed",
              "not allowed" in _strip_label(live_row.actions))

        db_g = sqlite3.connect(db)
        try:
            db_g.execute(f"UPDATE {store.table} SET time_suspended = NULL")
            db_g.commit()
        finally:
            db_g.close()
        win.reload()

        print("\nthe Archive button really archives")
        # Re-fetch rows: reload() above rebuilt every widget, so any row object
        # captured before it is stale and clicking it does nothing.
        rows = session_rows(win)
        # Pick an unarchived row explicitly. The list is grouped
        # unarchived-then-archived, so position is not a reliable proxy for
        # state once the real database holds archived sessions.
        unarchived = [r for r in rows
                      if r.session_id not in archived_ids(db)]
        check("an unarchived row exists to act on", len(unarchived) > 0)
        other = unarchived[0]
        sid = other.session_id
        check("session starts unarchived", sid not in archived_ids(db))
        click(other, button=1)
        check("its strip opened", other.actions.get_visible())
        btns = _find_buttons(other.actions)
        check("Archive button present", "Archive" in btns, str(list(btns)))
        btns["Archive"].clicked()
        while Gtk.events_pending():
            Gtk.main_iteration_do(False)
        check("session is archived in the database", sid in archived_ids(db))
        check("it moved out of the working list", sid not in {
            d["id"] for d in store.list() if not d["archived"]})

        print("\nthe grouping survives the write")
        rows2 = session_rows(win)
        # The total stays the same: the session moved from the working section
        # to the archived one. What matters is that it left the working half.
        check("row count unchanged (moved section, not removed)",
              len(rows2) == len(rows), f"{len(rows)} -> {len(rows2)}")
        check("strips hidden again after reload",
              all(not getattr(r, "actions").get_visible() for r in rows2))
        check("session now listed under Archived",
              any(r.session_id == sid for r in rows2))

        print("\nrestore button works")
        # Act on an archived row that this run created, so the assertion does
        # not depend on whatever else is already archived in the real database.
        back = [r for r in rows2 if r.session_id == sid]
        check("archived row appears exactly once", len(back) == 1)
        if back:
            strip = back[0].actions
            btns2 = _find_buttons(strip)
            check("Restore button present on an archived row",
                  "Restore" in btns2, str(list(btns2)))
            btns2["Restore"].clicked()
            while Gtk.events_pending():
                Gtk.main_iteration_do(False)
            check("session is no longer archived", sid not in archived_ids(db))

        print("\nthe strip's Close does nothing at all")
        # The failure this guards: a button meant only to back out of the strip
        # that also archived, deleted, or wrote a file on the way past. Checked
        # by watching the database and the filesystem, not by clicking twice and
        # looking at the status line.
        out = tmp / "fake-downloads"
        out.mkdir(exist_ok=True)
        real_out = win._out_dir
        win._out_dir = lambda: out
        try:
            victim_row = next(r for r in session_rows(win)
                              if r.session_id not in archived_ids(db))
            sid_before = victim_row.session_id
            archived_before = archived_ids(db)
            files_before = sorted(p.name for p in out.iterdir())

            click(victim_row, button=1)
            check("strip opened for the Close test",
                  victim_row.actions.get_visible())
            btns_close = _find_buttons(victim_row.actions)
            btns_close["Close"].clicked()
            while Gtk.events_pending():
                Gtk.main_iteration_do(False)

            check("Close hides the strip", not victim_row.actions.get_visible())
            check("Close unselects the row",
                  win.listbox.get_selected_row() is None)
            check("Close archived nothing",
                  archived_ids(db) == archived_before)
            check("Close wrote no file",
                  sorted(p.name for p in out.iterdir()) == files_before)
            check("Close left the session in the list",
                  sid_before in {d["id"] for d in store.list()})
        finally:
            win._out_dir = real_out

        print("\nTranscript.md writes to ~/Downloads and says where")
        # _out_dir is redirected at the real one here, so the assertion is about
        # the path the window reports, not about polluting the user's Downloads.
        real_out = win._out_dir
        out = tmp / "fake-downloads"
        win._out_dir = lambda: out
        try:
            row_md = next(r for r in session_rows(win)
                          if r.session_id not in archived_ids(db))
            data_md = next(d for d in store.list() if d["id"] == row_md.session_id)
            win._save_transcript(data_md)
            wanted = pop.slug_of(data_md["title"]) + ".md"
            made = out / wanted
            check("transcript file was created", made.exists(),
                  f"looked for {wanted}, saw {[p.name for p in out.iterdir()]}")
            if made.exists():
                body = made.read_text(encoding="utf8")
                check("it starts with the session header",
                      body.lstrip().startswith("# "), body[:60])
                check("it carries the session id",
                      data_md["id"] in body)
            check("the status line names the file",
                  made.name in win.status.get_text(),
                  win.status.get_text())
            # The ~ shortening is what the user asked for, so it is asserted
            # against a real path under home rather than the redirected
            # directory the test writes into.
            check("paths under home are shortened to ~",
                  pop.short_home(Path.home() / "Downloads" / "x.md")
                  == "~/Downloads/x.md",
                  pop.short_home(Path.home() / "Downloads" / "x.md"))
        finally:
            win._out_dir = real_out

        print("\nExport.json goes through the opencode CLI")
        # Stubbed rather than run: the real `opencode session export` writes
        # megabytes from the running server, and what needs proving here is the
        # plumbing -- which command is run, where the bytes land, and what
        # happens when it fails.
        out = tmp / "fake-downloads"
        real_out, real_run = win._out_dir, pop.subprocess.run
        ran = []

        class Proc:
            returncode = 0
            stderr = b""

        def fake_run(argv, **kw):
            ran.append((argv, kw))
            kw["stdout"].write(b'{"info":{"id":"x"},"messages":[]}')
            return Proc()

        pop.subprocess.run = fake_run
        win._out_dir = lambda: out
        try:
            row_x = next(r for r in session_rows(win)
                         if r.session_id not in archived_ids(db))
            data_x = next(d for d in store.list() if d["id"] == row_x.session_id)
            win._export_json(data_x)
            check("it ran the opencode CLI's own export",
                  ran and ran[0][0][:3] == ["opencode", "session", "export"],
                  str(ran[:1]))
            check("it passed the session id",
                  ran and ran[0][0][-1] == data_x["id"])
            json_file = out / (pop.slug_of(data_x["title"]) + ".json")
            check("the CLI's bytes landed in the file",
                  json_file.exists() and json_file.read_bytes()
                  == b'{"info":{"id":"x"},"messages":[]}',
                  str(sorted(p.name for p in out.iterdir())))
            check("no temp file was left behind",
                  not [p for p in out.iterdir()
                       if p.suffix == ".json" and "tmp" in p.name],
                  str(sorted(p.name for p in out.iterdir())))
        finally:
            pop.subprocess.run = real_run
            win._out_dir = real_out

        print("\na failed export reports it and writes nothing")
        out = tmp / "fake-downloads"
        real_out, real_run = win._out_dir, pop.subprocess.run

        class Failed:
            returncode = 1
            stderr = b"session not found"

        pop.subprocess.run = lambda argv, **kw: (
            kw["stdout"].write(b"{truncated"), Failed())[1]
        win._out_dir = lambda: out
        try:
            row_f = next(r for r in session_rows(win)
                         if r.session_id not in archived_ids(db))
            data_f = next(d for d in store.list() if d["id"] == row_f.session_id)
            before_files = sorted(p.name for p in out.iterdir())
            win._export_json(data_f)
            want = pop.slug_of(data_f["title"]) + ".json"
            check("no .json was written on failure",
                  sorted(p.name for p in out.iterdir()) == before_files,
                  str(sorted(p.name for p in out.iterdir())))
            check("no leftover temp file after failure",
                  not [p for p in out.iterdir() if "tmp" in p.name])
        finally:
            pop.subprocess.run = real_run
            win._out_dir = real_out

        print("\nDelete refuses the live session in the write path, not just the button")
        # The disabled button is a courtesy; this is the rule. Tested by calling
        # the function, because a disabled button proves nothing about a caller
        # that is not the button.
        live_id = session_rows(win)[0].session_id
        db_g = sqlite3.connect(db)
        try:
            db_g.execute(
                f"UPDATE {store.table} SET time_suspended = ? WHERE id = ?",
                (int(datetime.datetime.now().timestamp() * 1000), live_id),
            )
            db_g.commit()
        finally:
            db_g.close()
        refused = False
        try:
            pop.delete_session(store, live_id)
        except ValueError as err:
            refused = "currently open" in str(err)
        check("delete_session refuses the live session", refused)
        check("and it is still there",
              live_id in {d["id"] for d in store.list()})

        db_g = sqlite3.connect(db)
        try:
            db_g.execute(f"UPDATE {store.table} SET time_suspended = NULL")
            db_g.commit()
        finally:
            db_g.close()

        print("\nDelete really deletes, with its children, after a backup")
        rows = session_rows(win)

        def count_where(db_path, sql, args=()):
            conn = sqlite3.connect(db_path)
            try:
                return conn.execute(sql, args).fetchone()[0]
            finally:
                conn.close()

        def has_messages(sid):
            return count_where(
                db, "SELECT COUNT(*) FROM session_message WHERE session_id = ?",
                (sid,)) > 0

        # A seeded fixture has no message rows, so pick a session that actually
        # carries a conversation: the delete's cascade is the thing under test.
        gone_row = next(r for r in rows
                        if r.session_id not in archived_ids(db)
                        and has_messages(r.session_id))
        gone_id = gone_row.session_id
        title = gone_id

        msgs_before = count_where(
            db, "SELECT COUNT(*) FROM session_message WHERE session_id = ?", (gone_id,))
        check("the session has messages to take with it", msgs_before > 0,
              f"{msgs_before} messages")

        removed = pop.delete_session(store, gone_id)
        check("delete_session reports success", removed is True)
        check("the session row is gone",
              gone_id not in {d["id"] for d in store.list()})
        check("its messages are gone too",
              count_where(db, "SELECT COUNT(*) FROM session_message "
                              "WHERE session_id = ?", (gone_id,)) == 0)
        parts_left = None
        if count_where(db, "SELECT COUNT(*) FROM sqlite_master "
                           "WHERE type='table' AND name='part'") > 0:
            parts_left = count_where(db, "SELECT COUNT(*) FROM part "
                                         "WHERE session_id = ?", (gone_id,))
            check("its parts are gone too", parts_left == 0, str(parts_left))
        backups_after = sorted(
            (tmp / "backups").glob("*.db"), key=lambda p: p.stat().st_mtime)
        check("a backup was taken first", bool(backups_after),
              "no snapshot in the backups directory")
        # The count cannot grow: RETAIN prunes to three, so an archive-then-delete
        # leaves the directory the same size. What matters is that the newest
        # snapshot still holds the session, which is only true if it was taken
        # before the rows went.
        if backups_after:
            newest = sqlite3.connect(f"file:{backups_after[-1]}?mode=ro", uri=True)
            try:
                kept = newest.execute(
                    "SELECT COUNT(*) FROM session_v2 WHERE id = ?", (gone_id,)
                ).fetchone()[0]
            except sqlite3.Error:
                kept = None
            finally:
                newest.close()
            check("the newest backup still contains the deleted session",
                  kept == 1, f"session rows in snapshot: {kept}")

        print("\nDelete asks before deleting")
        # The dialog itself: Cancel must be the default and focused, because a
        # confirmation that defaults to the destructive button is a confirmation
        # that gets reflexively accepted.
        dialogs = []
        real_msg = Gtk.MessageDialog

        def spy(*a, **kw):
            d = real_msg(*a, **kw)
            dialogs.append(d)
            return d

        pop.Gtk.MessageDialog = spy
        try:
            # Reload first: the row deleted above is still a widget in the
            # listbox, and picking from stale widgets tests the wrong session.
            win.reload()
            live_now = {d["id"] for d in store.list() if d.get("is_live")}
            doomed = next(r for r in session_rows(win)
                          if r.session_id not in archived_ids(db)
                          and r.session_id not in live_now)
            doomed_id = doomed.session_id
            win._delete_session(
                next(d for d in store.list() if d["id"] == doomed_id))
            check("Delete opened a confirmation", len(dialogs) == 1)
            if dialogs:
                dlg = dialogs[0]
                btns_d = _find_buttons(dlg)
                check("it offers Cancel, Archive instead and Delete",
                      set(btns_d) == {"Cancel", "Archive instead", "Delete"},
                      str(sorted(btns_d)))
                # GTK3 has no getter for the default response, so this asserts
                # the observable consequence: focus lands on Cancel, and Enter
                # cannot reach Delete.
                check("focus starts on Cancel",
                      dlg.get_focus() is btns_d["Cancel"],
                      str(dlg.get_focus()))
                check("the focus is not on Delete",
                      dlg.get_focus() is not btns_d.get("Delete"))
                check("nothing was deleted while it was open",
                      doomed_id in {x["id"] for x in store.list()})
                dlg.response(Gtk.ResponseType.CANCEL)
                while Gtk.events_pending():
                    Gtk.main_iteration_do(False)
                check("Cancel deletes nothing",
                      doomed_id in {x["id"] for x in store.list()})

                print("\nDelete on confirmation removes the session")
                win._delete_session(
                    next(d for d in store.list() if d["id"] == doomed_id))
                while Gtk.events_pending():
                    Gtk.main_iteration_do(False)
                if dialogs:
                    check("the dialog was shown again", len(dialogs) == 2,
                          f"{len(dialogs)} dialogs")
                    last = dialogs[-1]
                    # Answer it as Delete, found by label rather than by
                    # response id, so the test does not restate the mapping.
                    _find_buttons(last)["Delete"].clicked()
                    while Gtk.events_pending():
                        Gtk.main_iteration_do(False)
                    check("Delete removed the session",
                          doomed_id not in {x["id"] for x in store.list()},
                          "still present after Delete")
                    check("and removed it from the window",
                          doomed_id not in
                          {r.session_id for r in session_rows(win)})
        finally:
            pop.Gtk.MessageDialog = real_msg

        print("\nthe banner describes the buttons the window actually has")
        # The banner is the first thing seen when /list_sessions opens, and it
        # went stale for a long time: it described a window with no Stats
        # button, because it was written before the stats feature and nothing
        # compared it against the widgets. Read the rendered label rather than
        # the source, so this is what a user would actually see.
        banner_text = ""
        found_labels = 0
        banner_label = None

        def walk_banner(w):
            nonlocal banner_text, found_labels, banner_label
            if isinstance(w, Gtk.Label):
                found_labels += 1
                if "banner-hint" in w.get_style_context().list_classes():
                    if banner_label is None:
                        banner_label = w
                    banner_text += (w.get_text() or "") + "\n"
            if isinstance(w, Gtk.Container):
                for ch in w.get_children():
                    walk_banner(ch)

        walk_banner(win)
        check("the banner is found at all", banner_text.strip() != "",
              f"walked {found_labels} labels, "
              f"{len(banner_text)} chars classed banner-hint")

        # The sentence that enumerates the buttons, not the whole banner.
        # Checking the whole thing passed against a banner with Stats deleted
        # from the list, because the paragraph below it also says "Stats".
        stripped = " ".join(banner_text.split())
        # A lookahead, not a bare `.` -- "Transcript.md" has a period in the middle of
        # it, so the first version of this truncated at "Transcript."
        _match = re.search(r"(?:open|for) its buttons:(.*?)\.(?=\s|$)", stripped)
        check("the button list is found in the banner", _match is not None,
              stripped[:140])
        # Named `_match` rather than `m`: an earlier version of this reused `m`,
        # which happened to work only because it had just bound a match --
        # and the popup module is `pop` here, so `m` is not a name that means
        # anything later in the file.
        button_list = _match.group(1) if _match else ""
        check("it names the per-session Stats button", "Stats" in button_list,
              button_list)
        for action in ("Archive", "Transcript.md", "Export.json", "Delete"):
            check(f"the button list still names {action}", action in button_list)
        check("and says Close does nothing", "Close" in button_list, button_list)

        # Those are checked against the banner as a whole, because they are
        # prose rather than a list.
        check("it explains the footer Database button", "Database" in banner_text)
        check("and says the reports are read-only", "read-only" in banner_text)
        check("and names the footer Database button", "Database" in banner_text)

        # The banner must not dictate the window's width. It did: three long
        # unwrapped paragraphs made the label request more than the 1100px
        # default, and set_default_size loses to any child that asks for more.
        # banner_label is captured by walk_banner above.
        check("the banner label is found", banner_label is not None)
        if banner_label is not None:
            check("it wraps rather than asking for one long line",
                  banner_label.get_line_wrap(),
                  "an unwrapped label's natural width becomes the window width")
            check("and its wrap width is capped",
                  0 < banner_label.get_width_chars() <= 200,
                  f"width_chars={banner_label.get_width_chars()}")
            check("so the banner cannot widen the window past the default",
                  0 < banner_label.get_max_width_chars() <= 200,
                  f"max_width_chars={banner_label.get_max_width_chars()}")

        # The invariant, rather than a proxy for it. BANNER_COLS is tuned to the
        # default font, so asserting the constant would only prove the constant
        # did not change.
        #
        # This is the check that was missing when a five-paragraph banner
        # opened the window at 2092px on a 1366px screen: every existing test
        # passed while the window was unusable.
        _screen = Gdk.Screen.get_default()
        _sw, _sh = _screen.get_width(), _screen.get_height()
        _win_w, _win_h = win.get_size()
        check("the window fits the screen horizontally",
              _win_w <= _sw, f"{_win_w}px wide on a {_sw}px screen")
        check("and vertically", _win_h <= _sh, f"{_win_h}px tall on a {_sh}px screen")
        check("and is not needlessly narrow",
              _win_w >= _sw * 0.5, f"{_win_w}px on a {_sw}px screen")

        # The banner is guidance for a window you drive with the mouse. It
        # grew to five paragraphs once and was cut back; this stops it growing
        # into a manual again.
        paragraphs = [p for p in banner_text.split("\n\n") if p.strip()]
        check("the banner is not a manual", len(paragraphs) <= 4,
              f"{len(paragraphs)} paragraphs")
        check("and is not so long that it needs the window to grow",
              len(stripped) < 600, f"{len(stripped)} chars")

        print("\ntext size is adjustable, and the choice is kept")
        _prefs = Path("~/.config/session-list-popup/font-size").expanduser()
        _saved_pref = _prefs.read_text() if _prefs.exists() else None
        try:
            check("the window starts at the saved size, or the default",
                  win.font_size == pop.load_font_size(),
                  f"window {win.font_size}, saved {pop.load_font_size()}")
            check("A-, A+ and a reset control are all present",
                  all(any(b.get_label() == want for b in _buttons(win))
                      for want in ("A-", "A+", "Reset size")),
                  str(sorted(b.get_label() for b in _buttons(win))))

            # Identity at the default, so adding the scale changes nothing for
            # anyone who never touches the buttons.
            _same = pop.scaled_css(pop.CSS, pop.FONT_DEFAULT)
            check("the default size renders exactly the shipped CSS",
                  _same == pop.CSS,
                  "scaling at FONT_DEFAULT must be the identity")

            _big = pop.scaled_css(pop.CSS, pop.FONT_DEFAULT + 6)
            _small = pop.scaled_css(pop.CSS, pop.FONT_DEFAULT - 4)
            _px = lambda css: [int(x) for x in
                               re.findall(rb"font-size:\s*(\d+)px", css)]
            check("a larger size makes every font larger",
                  all(b > a for a, b in zip(_px(pop.CSS), _px(_big))),
                  f"{_px(pop.CSS)[:4]} -> {_px(_big)[:4]}")
            check("a smaller size makes every font smaller",
                  all(b < a for a, b in zip(_px(pop.CSS), _px(_small))))
            check("no font collapses to nothing at the minimum",
                  all(px >= 1 for px in _px(pop.scaled_css(pop.CSS, pop.FONT_MIN))),
                  str(_px(pop.scaled_css(pop.CSS, pop.FONT_MIN))))

            # Padding and border-radius are numbers in the same stylesheet and
            # are NOT text size. A greedy match rewrites them and the layout
            # shifts under the user's hands.
            _nonfont = re.findall(rb"(padding:\s*[^;]+|border-radius:\s*[^;]+)",
                                  pop.CSS)
            check("non-font sizes are left alone",
                  re.findall(rb"(padding:\s*[^;]+|border-radius:\s*[^;]+)",
                             _big) == _nonfont,
                  "padding/border-radius must not scale with the text")

            win.font_size = pop.FONT_DEFAULT
            win.set_font_size(pop.FONT_DEFAULT + 4)
            check("set_font_size changes the size", win.font_size == pop.FONT_DEFAULT + 4)
            check("and it is written where the next window will find it",
                  _prefs.exists() and _prefs.read_text().strip() == str(win.font_size),
                  _prefs.read_text().strip() if _prefs.exists() else "not written")

            # The trap: add_provider_for_screen stacks providers, so adding one
            # per press leaves the old ones behind and Reset cannot undo it.
            _provider = win._css
            for _ in range(4):
                win.set_font_size(win.font_size + pop.FONT_STEP)
            check("pressing A+ repeatedly reloads one provider, not four",
                  win._css is _provider,
                  "a new provider per press would stack and Reset could not undo it")
            _up = win.font_size
            win.set_font_size(pop.FONT_DEFAULT)
            check("reset actually goes back down, rather than staying high",
                  win.font_size == pop.FONT_DEFAULT and win.font_size < _up,
                  f"{_up} -> {win.font_size}")
            check("and the provider is still the same one after resetting",
                  win._css is _provider)

            # Clamped, so holding the key down cannot produce a 0px window.
            win.set_font_size(pop.FONT_MAX + 500)
            check("the size is clamped at the maximum", win.font_size == pop.FONT_MAX,
                  str(win.font_size))
            win.set_font_size(pop.FONT_MIN - 500)
            check("and at the minimum", win.font_size == pop.FONT_MIN, str(win.font_size))

            # Text size must not become a window-size control. Two separate
            # mechanisms got this wrong: `width_chars` is a character count, so
            # a fixed one grows the banner in pixels as the font grows; and the
            # wrapped paragraphs get tall enough to push the window off the
            # screen. Both are invisible until you actually try a big size.
            _screen2 = Gdk.Screen.get_default()
            _sw2, _sh2 = _screen2.get_width(), _screen2.get_height()
            for _size in (pop.FONT_MIN, pop.FONT_DEFAULT, 15, 17, 25, pop.FONT_MAX):
                win.set_font_size(_size)
                while Gtk.events_pending():
                    Gtk.main_iteration_do(False)
                _w, _h = win.get_size()
                check(f"the window still fits the screen at {_size}px",
                      _w <= _sw2 and _h <= _sh2, f"{_w}x{_h} on {_sw2}x{_sh2}")

            # The banner's width must shrink as the font grows, or a fixed
            # char count is a pixel width that moves.
            check("the banner wrap width shrinks as the font grows",
                  pop.banner_cols(30) < pop.banner_cols(pop.FONT_DEFAULT) < pop.banner_cols(9),
                  f"9px={pop.banner_cols(9)} 11px={pop.banner_cols(pop.FONT_DEFAULT)} "
                  f"30px={pop.banner_cols(30)}")
            check("and never drops below a usable line length",
                  pop.banner_cols(pop.FONT_MAX) >= 40, str(pop.banner_cols(pop.FONT_MAX)))
            # Checked on the live window as well as the function: set_font_size
            # has to re-derive the wrap, and only a fresh window's size catches
            # the construction path. Pressing A+ in an open window is the one
            # a person actually does, and it is the one that was missed.
            win.set_font_size(pop.FONT_MAX)
            check("changing the size re-derives the banner wrap on the open window",
                  win.banner_label.get_width_chars() == pop.banner_cols(pop.FONT_MAX),
                  f"label {win.banner_label.get_width_chars()} vs "
                  f"expected {pop.banner_cols(pop.FONT_MAX)}")

            # A *fresh* window at a saved size, which is the case that went to
            # 3778px: the CSS and the wrap are both applied at construction.
            _prefs.parent.mkdir(parents=True, exist_ok=True)
            _prefs.write_text("25\n")
            _fresh = pop.Window(pop.Store(db))
            _fresh.show_all()
            while Gtk.events_pending():
                Gtk.main_iteration_do(False)
            _fw, _fh = _fresh.get_size()
            check("a fresh window at a large saved size still fits",
                  _fw <= _sw2 and _fh <= _sh2, f"{_fw}x{_fh} on {_sw2}x{_sh2}")
            check("and it really did start at that size",
                  _fresh.font_size == 25, str(_fresh.font_size))
            _fresh.destroy()

            win.set_font_size(pop.FONT_DEFAULT)
        finally:
            win.set_font_size(pop.FONT_DEFAULT)
            if _saved_pref is None:
                _prefs.unlink(missing_ok=True)
            else:
                _prefs.write_text(_saved_pref)

        print("\nno button nobody asked for")
        # Copy id was in the popup's first commit, back when the numbered menus
        # printed ids to copy. The id is on screen under every title, and it
        # was the weakest of seven buttons. A test so it does not return as
        # "while we're here".
        _labels = {b.get_label() for b in _buttons(win)}
        check("Copy id is gone", "Copy id" not in _labels, str(sorted(_labels)))
        _src = Path(pop.__file__).read_text()
        check("and nothing wires it to a button",
              'Gtk.Button(label="Copy id")' not in _src)

        print("\nrows announce that they can be clicked")
        # The CSS must PARSE, not merely contain a rule. GTK3 rejects `:has()`
        # with an exception rather than ignoring it, so an earlier attempt to
        # exclude section rows from the hover silently took the whole stylesheet
        # down with it -- and nothing in this suite would have said so.
        _parsed = True
        _err = ""
        try:
            _p = Gtk.CssProvider()
            _p.load_from_data(pop.scaled_css(pop.CSS, pop.FONT_DEFAULT))
        except Exception as _e:  # noqa: BLE001 -- any failure is a broken CSS
            _parsed, _err = False, str(_e)[:120]
        check("the shipped stylesheet parses", _parsed, _err)
        _css = pop.scaled_css(pop.CSS, pop.FONT_DEFAULT).decode()
        check("rows have a hover style, so a clickable row looks clickable",
              re.search(r"row\.hover\s*\{[^}]*background-color", _css) is not None,
              "no row.hover background rule")
        check("the hover is lighter than the selected row, so it cannot be "
              "mistaken for a selection",
              _css.count("#f2f6f9") == 1 and "row.selected { background-color: #d6e8f5" in _css)
        check("no selector GTK3 cannot parse",
              ":has(" not in _css and ":is(" not in _css and ":where(" not in _css)
        # Section rows are set_selectable(False), so GTK never hovers them --
        # checked here because it is the reason no exclusion rule is needed.
        _section_rows = [r for r in win.listbox.get_children()
                         if getattr(r, "is_section", False)]
        check("section rows are not selectable, so they never hover",
              _section_rows and all(not r.get_selectable() for r in _section_rows),
              f"{len(_section_rows)} section rows")

        print("\nscript paths in the report are whole")
        _store = pop.Store(db)
        _env = dict(pop.database_sections(pop.database_stats(_store), _store))
        _lines = _env["ENVIRONMENT"].splitlines()
        _paths = [l.strip() for l in _lines if "popup/" in l]
        check("the resolved script paths are in the report", len(_paths) >= 1,
              str(_paths))
        # Truncated from the left, these read "…ct/opencode-session-transcript"
        # -- which names the repo but not where it is, so it cannot answer the
        # one question the line exists for: is this the copy in ~/.local/bin
        # or the one in the checkout?
        check("and none of them are elided",
              all("…" not in p for p in _paths), str(_paths))
        check("each path is absolute, so it says where it lives",
              all(p.split(None, 1)[1].startswith("/") for p in _paths if " " in p),
              str(_paths))

        print("\nthe real database was not modified by this run")
        # Compare against the state captured at the start, not against "no
        # archived sessions" — the user's own real database legitimately holds
        # archived sessions, because archiving from this window is the feature.
        check("real db archived set unchanged by these tests",
              archived_ids(REAL) == real_before,
              f"{len(real_before)} before, {len(archived_ids(REAL))} after")

        win.destroy()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
    return 1 if FAIL else 0


def _find_buttons(box):
    out = {}
    for child in box.get_children():
        if isinstance(child, Gtk.Button):
            out[child.get_label()] = child
        elif isinstance(child, Gtk.Container):
            out.update(_find_buttons(child))
    return out


def _buttons(widget):
    """Every button under a widget, flattened. Empty when there are none."""
    out = []
    if isinstance(widget, Gtk.Button):
        out.append(widget)
    if isinstance(widget, Gtk.Container):
        for child in widget.get_children():
            out.extend(_buttons(child))
    return out


def _all_boxes(widget):
    """Every container under a widget, so a footer can be searched by shape."""
    out = [widget]
    if isinstance(widget, Gtk.Container):
        for child in widget.get_children():
            out.extend(_all_boxes(child))
    return out


def _chips(row):
    """The chip labels on a row, e.g. ARCHIVED or THIS SESSION."""
    out = []

    def walk(w):
        if isinstance(w, Gtk.Label):
            out.append(w.get_text())
        elif isinstance(w, Gtk.Container):
            for ch in w.get_children():
                walk(ch)
    walk(row)
    return out


def _all_widgets(w):
    """Every widget in a subtree."""
    out = [w]
    if isinstance(w, Gtk.Container):
        for ch in w.get_children():
            out.extend(_all_widgets(ch))
    return out


def _strip_label_widget(box):
    """The action-strip text label itself."""
    for child in box.get_children():
        if isinstance(child, Gtk.Label):
            return child
        if isinstance(child, Gtk.Container):
            found = _strip_label_widget(child)
            if found is not None:
                return found
    return None


def _strip_label(box):
    """The text of the first label in an action strip."""
    for child in box.get_children():
        if isinstance(child, Gtk.Label):
            return child.get_text()
        if isinstance(child, Gtk.Container):
            found = _strip_label(child)
            if found:
                return found
    return ""


if __name__ == "__main__":
    sys.exit(main())