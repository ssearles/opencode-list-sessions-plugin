#!/usr/bin/env python3
"""
Prove the stats figures are right, without needing to read them and believe them.

Two of these checks exist because the first cut of this feature was wrong in
exactly those ways and rendered perfectly anyway:

- the byte total was summed over the `type` column instead of `data`, so every
  session reported "2 KB" and the number looked like a real figure
- models and message kinds were read from the JSON blob, but `type` is a COLUMN,
  so both came back empty

A wrong number that looks like a number is worse than no number, so those two
are pinned directly.

Works on a VACUUM INTO copy of the real database, exactly like the other popup
suites, and never touches the original.
"""

import importlib.machinery
import importlib.util
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gtk  # noqa: E402

REAL = Path.home() / ".local" / "share" / "opencode" / "opencode.db"
# Defaults to this repo's copy so the suite tests what is committed; override
# with SESSION_POPUP to test an installed or mutated build. The other popup
# suites take the same variable, and this one initially did not -- which meant a
# mutation run reported eight survivors that were really just eight mutations
# the suite had never loaded.
SCRIPT = Path(
    os.environ.get("SESSION_POPUP")
    or Path(__file__).resolve().parent / "session-list-popup"
)

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


tmp = Path(tempfile.mkdtemp(prefix="popup-stats-"))
db = tmp / "opencode.db"
src = sqlite3.connect(f"file:{REAL}?mode=ro", uri=True)
try:
    src.execute("VACUUM INTO ?", (str(db),))
finally:
    src.close()

store = pop.Store(db)
rows = store.list()
sample = rows[0]["id"]

print("\nthe stats functions read the real database")
s = pop.session_stats(store, sample)
check("a session produces a report", bool(s))
check("an unknown session produces nothing, not a crash",
      pop.session_stats(store, "ses_does_not_exist") == {})

print("\nsize is measured, not estimated")
check("the byte total is non-zero", s.get("bytes", 0) > 0,
      f"{s.get('bytes')} bytes")
# The regression this pins: summing LENGTH over the wrong column gave 2 KB for a
# 1.7 MB session, and it rendered without complaint.
raw_total = store._connect().execute(
    "SELECT COALESCE(SUM(LENGTH(data)),0) FROM session_message WHERE session_id=?",
    (sample,)).fetchone()[0]
check("and it matches SQL exactly", s["bytes"] == raw_total,
      f"python {s['bytes']} vs sql {raw_total}")
check("a session with messages is over a kilobyte", s["bytes"] > 1024,
      f"{s['bytes']} bytes")

print("\nmessage kinds and models come from the type COLUMN")
check("kinds are counted", bool(s.get("kinds")), str(s.get("kinds")))
check("assistant messages are among them", "assistant" in s["kinds"],
      str(list(s["kinds"])[:6]))
check("models are counted", bool(s.get("models")), str(s.get("models")))

print("\ntools and files are read out of the tool calls")
check("tool calls are counted", s["tool_calls"] > 0, str(s["tool_calls"]))
check("tools are broken down", bool(s["tools"]), str(list(s["tools"])[:5]))
check("failures are counted", s["errors"] >= 0, str(s["errors"]))
if s["tool_calls"]:
    check("the error rate is plausible",
          s["errors"] <= s["tool_calls"], f"{s['errors']}/{s['tool_calls']}")

print("\ntime is measured two ways")
check("wall clock is positive", s["wall_ms"] >= 0, str(s["wall_ms"]))
check("active time never exceeds wall clock",
      s["active_ms"] <= s["wall_ms"] + 1,
      f"active {s['active_ms']} vs wall {s['wall_ms']}")
check("active time is a real figure, not zero for a worked session",
      s["active_ms"] > 0 or s["messages"] <= 1,
      f"active {s['active_ms']} over {s['messages']} messages")

print("\ncost is reported even when it is zero")
check("cost is a number", isinstance(s["cost"], (int, float)), repr(s["cost"]))
check("the token blocks are all present",
      set(s["tokens"]) == {"input", "output", "reasoning",
                           "cache_read", "cache_write"},
      str(sorted(s["tokens"])))

print("\nthe database report agrees with itself")
d = pop.database_stats(store)
check("it covers every session", d["sessions"] == len(rows),
      f"{d['sessions']} vs {len(rows)}")
check("per-session sizes sum to the message total",
      sum(v[1] for v in d["sizes"].values()) == d["message_bytes"],
      f"{sum(v[1] for v in d['sizes'].values())} vs {d['message_bytes']}")
check("messages are counted", d["messages"] > 0, str(d["messages"]))
check("the database is at least as big as its messages",
      d["on_disk"] >= d["message_bytes"],
      f"{d['on_disk']} on disk vs {d['message_bytes']} of messages")
check("archived is a subset of sessions", 0 <= d["archived"] <= d["sessions"])
check("total cost is a number", isinstance(d["cost"], (int, float)), repr(d["cost"]))

print("\nthe reports render as text")
one = pop.format_session_report(s)
for section in ("SIZE", "TIME", "COST AND TOKENS", "ACTIVITY",
                "TOOLS", "FILES TOUCHED", "SESSION"):
    check(f"the session report has a {section} section", section in one)
check("the session report names the cost even at zero", "$" in one)
check("the session report shows the cache share", "cache" in one.lower())

whole = pop.format_database_report(d)
for section in ("ON DISK", "CONTENTS", "COST AND TOKENS, ALL SESSIONS",
                "LARGEST SESSIONS", "TOOLS, ALL SESSIONS"):
    check(f"the database report has a {section} section", section in whole)
check("both reports survive an empty report",
      pop.format_session_report({}) == "No such session."
      and pop.format_database_report({}) == "No sessions found.")

print("\npaths in the report keep their filenames")
if d["files"]:
    rendered = pop.format_database_report(d)
    # The DISPLAYED ones -- the report shows the most-touched files, so the
    # longest path by name may not appear in it at all. Testing an unrendered
    # path passes for the wrong reason, which is how the first version of this
    # check reported a truncation that was not there.
    shown = [str(name) for name, _n in d["files"].most_common(14)]
    clipped = [n for n in shown if len(n) > 46]
    missing = [n for n in clipped if n[-20:] not in rendered]
    check("no displayed path lost its tail", not missing,
          f"lost the tail of {missing[0][-40:]!r}" if missing else
          f"{len(clipped)} of {len(shown)} were clipped")
    # The ellipsis is added at RENDER time by _short(), so the raw path does not
    # contain one. Assert the rendered form: "…" plus the last 45 characters.
    unshortened = [n for n in clipped
                   if f"…{n[-(pop._short(n, 46).__len__() - 1):]}" not in rendered]
    check("a clipped path is marked as shortened", not unshortened,
          f"{unshortened[0][-40:]!r}" if unshortened else
          f"{len(clipped)} clipped, all marked")

print("\nlong sections start folded, short ones open")
secs = pop.session_sections(s)
win = pop.StatsWindow("probe", secs)
while Gtk.events_pending():
    Gtk.main_iteration_do(False)
named = [x for x in secs if x[0]]
check("a window builds from sections", bool(win._expanders),
      f"{len(win._expanders)} expanders")
check("every named section has one",
      len(win._expanders) == len(named), f"{len(win._expanders)} vs {len(named)}")
for exp, (heading, body) in zip(win._expanders, named):
    expected = len(body.splitlines()) <= pop.FOLD_AFTER_LINES
    check(f"{heading} starts {'open' if expected else 'folded'}",
          exp.get_expanded() is expected)
check("at least one section is open, so the overview is readable",
      any(e.get_expanded() for e in win._expanders))
check("a long section is folded when one exists",
      any(not e.get_expanded() for e in win._expanders)
      or all(len(b.splitlines()) <= pop.FOLD_AFTER_LINES for _h, b in named))

print("\ncollapse all and expand all do what they say")
win._set_all(False)
while Gtk.events_pending():
    Gtk.main_iteration_do(False)
check("everything folds", not any(e.get_expanded() for e in win._expanders))
win._set_all(True)
while Gtk.events_pending():
    Gtk.main_iteration_do(False)
check("everything opens", all(e.get_expanded() for e in win._expanders))
win.destroy()

print("\ncopy carries every section, folded or not")
copied = pop.report_text(pop.session_sections(s))
check("every heading is in the copied text",
      all(h in copied for h, _b in named))
check("and every body is too",
      all(b.splitlines()[0] in copied for _h, b in named if b.strip()))

# Press the actual button rather than trusting report_text: _on_copy builds its
# own string, and a version that dropped the sections would pass every check
# above while copying nothing useful.
sent = {}


def fake_run(argv, **kwargs):
    sent["argv"] = argv
    sent["text"] = (kwargs.get("input") or b"").decode("utf8", "replace")
    return subprocess.CompletedProcess(argv, 0, b"", b"")


real_run = pop.subprocess.run
pop.subprocess.run = fake_run
try:
    win2 = pop.StatsWindow("probe2", pop.session_sections(s))
    win2._on_copy()
finally:
    pop.subprocess.run = real_run
    win2.destroy()
check("Copy goes through wl-copy", sent.get("argv") == ["wl-copy"],
      str(sent.get("argv")))
check("and what it hands over is the whole report",
      all(h in sent.get("text", "") for h, _b in named),
      f"{len(named)} headings")
check("not just the sections that happen to be open",
      sent.get("text") == copied,
      "the clipboard text differs from report_text()")

print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
for name in FAIL:
    print(f"  failed: {name}")
shutil.rmtree(tmp, ignore_errors=True)
sys.exit(1 if FAIL else 0)