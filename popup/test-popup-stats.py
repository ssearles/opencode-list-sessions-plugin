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
import json
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


def _write(directory, name, text):
    """A fixture file, so a reader can be pointed somewhere known."""
    path = directory / name
    path.write_text(text)
    return str(path)

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

print("\nfiles are grouped by directory, in full")
if d["files"]:
    groups = pop.group_by_directory(d["files"])
    placed = sum(len(rows) for _label, rows in groups)
    check("every file lands in a group", placed == len(d["files"]),
          f"{placed} vs {len(d['files'])}")
    check("no file is dropped as 'and N more'",
          not any("more" in r for _l, rows in groups for r in rows))
    check("directory paths are not truncated away",
          all(not label.startswith("…") for label, _r in groups),
          "a directory heading was clipped")
    # The heading must be the WHOLE directory. Comparing against the real set
    # catches any truncation at all, including a plain slice that adds no
    # ellipsis -- which a `startswith("…")` check waves straight through.
    real_dirs = {str(p).rpartition("/")[0] for p in d["files"]}
    shown_dirs = {label.rstrip().rsplit("  —", 1)[0].rstrip("/")
                  for label, _r in groups}
    check("every directory appears in full",
          shown_dirs == real_dirs,
          f"{len(shown_dirs)} headings vs {len(real_dirs)} real directories")
    check("filenames are indented under their directory",
          all(r.startswith("  ") for _l, rows in groups for r in rows),
          "a filename row is not indented")
    # The complaint that drove the grouping: two rows both opening with the same
    # leading ellipsis could not be told apart, because the ellipsis had eaten
    # the part naming the project.
    projects = {label.split("/")[3] for label, _r in groups
                if label.count("/") > 3}
    check("different projects are told apart", len(projects) > 1,
          str(sorted(projects)))

    # And the SECTION must hold the grouped form. Calling group_by_directory()
    # directly and liking the answer proves nothing about what the window is
    # actually handed -- which is exactly what survived a mutation that put the
    # flat truncated list back.
    section = dict(pop.database_sections(d)).get("MOST TOUCHED FILES")
    check("the report section holds groups, not a flat string",
          isinstance(section, list) and bool(section)
          and isinstance(section[0], tuple), type(section).__name__)
    if isinstance(section, list) and section:
        listed = sum(len(rows) for _l, rows in section)
        check("and it lists every file the store knows about",
              listed == len(d["files"]), f"{listed} vs {len(d['files'])}")

    # The SESSION report's own file section is a separate call site, and it is
    # the one a mutation reverted while every check in this block passed.
    own = dict(pop.session_sections(s)).get("FILES TOUCHED")
    check("the session report's file section is grouped too",
          isinstance(own, list) and bool(own)
          and isinstance(own[0], tuple), type(own).__name__)
    if isinstance(own, list) and own:
        check("and it lists every file that session touched",
              sum(len(r) for _l, r in own) == len(s["files"]),
              f"{sum(len(r) for _l, r in own)} vs {len(s['files'])}")

    rendered = pop.format_database_report(d)
    first_dir = groups[0][0].rstrip().rsplit("  —", 1)[0].rstrip("/")
    check("the rendered report shows the directory in full",
          first_dir in rendered, first_dir[:50])
    check("and no filename row carries a full path again",
          all(r.strip().startswith("/") is False
              for _l, rows in groups for r in rows))

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
    # Counted HERE, independently, rather than through the module's own helper.
    # Asking _as_text() what the window should have decided moves both sides at
    # once when it is wrong -- which is how a mutation that made _as_text count
    # directory groups instead of file rows passed every check.
    counted = (len(body.splitlines()) if isinstance(body, str)
               else sum(len(rows) + 1 for _label, rows in body))
    expected = counted <= pop.FOLD_AFTER_LINES
    check(f"{heading} starts {'open' if expected else 'folded'}",
          exp.get_expanded() is expected,
          f"{counted} lines, limit {pop.FOLD_AFTER_LINES}")
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
      all(pop._as_text(b).splitlines()[0] in copied
          for _h, b in named if pop._as_text(b).strip()))

# Press the actual button rather than trusting report_text: _on_copy builds its
# own string, and a version that dropped the sections would pass every check
# above while copying nothing useful.
sent = {}


def fake_run(argv, **kwargs):
    sent["argv"] = argv
    sent["kwargs"] = kwargs
    sent["text"] = (kwargs.get("input") or b"").decode("utf8", "replace")
    return subprocess.CompletedProcess(argv, 0, b"", b"")


real_run = pop.subprocess.run
pop.subprocess.run = fake_run
try:
    win2 = pop.StatsWindow("probe2", pop.session_sections(s))
    win2._on_copy()
    toast = win2._toast_label.get_text()
    toast_shown = win2._toast_label.get_visible()
finally:
    pop.subprocess.run = real_run
    win2.destroy()
check("Copy goes through wl-copy", sent.get("argv") == ["wl-copy"],
      str(sent.get("argv")))
check("and does not capture the forked child's output",
      sent.get("kwargs", {}).get("stdout") is subprocess.DEVNULL
      and "capture_output" not in sent.get("kwargs", {}),
      str(sorted(sent.get("kwargs", {}))))
check("a successful copy says so in a toast",
      toast_shown and toast == "Copied to the clipboard", toast)
check("and what it hands over is the whole report",
      all(h in sent.get("text", "") for h, _b in named),
      f"{len(named)} headings")
check("not just the sections that happen to be open",
      sent.get("text") == copied,
      "the clipboard text differs from report_text()")

print("\nrunning processes are read from /proc")
procs = pop.running_processes()
check("something running was found", bool(procs), f"{len(procs)} processes")
if procs:
    p0 = procs[0]
    check("each has a pid", all(isinstance(p["pid"], int) and p["pid"] > 0
                                for p in procs))
    check("and a readable parent", all("ppid" in p for p in procs))
    check("resident memory is a sane size, not vsize",
          all(0 < p["rss_mb"] < 8000 for p in procs),
          f"largest {max(p['rss_mb'] for p in procs):,.0f} MB")
    check("cpu seconds are plausible", all(0 <= p["cpu_s"] for p in procs))
    check("elapsed time is positive", all(p["elapsed_s"] > 0 for p in procs))
    check("each is labelled in words, not by a command line",
          all(p["label"] and len(p["label"]) < 30 for p in procs),
          str([p["label"] for p in procs][:4]))
    check("this test's own process is not listed as an OpenCode process",
          not any("test-popup-stats" in p["cmd"] for p in procs))
    # The shell that launched this suite has the repo path in its command line,
    # so matching on the whole line reports it as OpenCode. Matching on the
    # program is what prevents that, and this is the check for it.
    shells = [p for p in procs
              if Path(p["cmd"].split(" ", 1)[0]).name
              in ("bash", "sh", "zsh", "fish", "grep", "python3")]
    check("no shell or interpreter is reported as an OpenCode process",
          not shells, str([p["cmd"][:44] for p in shells]))
    check("they are ordered biggest first",
          [p["rss_mb"] for p in procs] == sorted((p["rss_mb"] for p in procs),
                                                 reverse=True))
    rendered = pop.format_database_report(d)
    check("the report shows the section", "RUNNING PROCESSES" in rendered)
    check("with the pids in it",
          all(f"{p['pid']:,}" in rendered for p in procs[:3]),
          "a pid is missing from the rendered report")

print("\nthe machine is described, not guessed at")
env = pop.environment_stats(store)
check("the display session type is reported", bool(env.get("session_type")))
check("the GTK scale is reported", "gdk_scale" in env, str(env.get("gdk_scale")))
check("locale is judged utf-8 or not", isinstance(env["locale_utf8"], bool))

# Tested against a patched environment rather than against this machine, which
# is already UTF-8: checking the live value only proves it is true here, and a
# function that always returned True would pass that on every box but a broken
# one. LC_ALL wins over LANG, which is what makes a C locale reachable.
_saved_locale = {k: os.environ.get(k) for k in ("LC_ALL", "LC_CTYPE", "LANG")}


def _with_locale(**kw):
    for key, value in kw.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value
    try:
        return pop._utf8_locale()
    finally:
        for key, value in _saved_locale.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


check("a C locale is recognised as not utf-8",
      _with_locale(LC_ALL=None, LC_CTYPE=None, LANG="C") is False)
check("a latin-1 locale is recognised as not utf-8",
      _with_locale(LC_ALL=None, LC_CTYPE=None, LANG="en_US.ISO-8859-1") is False)
check("a UTF-8 locale is recognised",
      _with_locale(LC_ALL=None, LC_CTYPE=None, LANG="en_US.UTF-8") is True)
check("LC_ALL overrides LANG",
      _with_locale(LC_ALL="C", LC_CTYPE=None, LANG="en_US.UTF-8") is False)
check("no locale at all is not assumed to be utf-8",
      _with_locale(LC_ALL=None, LC_CTYPE=None, LANG=None) is False)
not_utf8 = dict(env, locale_utf8=False)
check("a non-utf8 locale is called out in the report, not hidden",
      "NOT utf-8" in "\n".join(pop._environment_lines(not_utf8)))
check("and a utf-8 locale is reported as such",
      "utf-8" in "\n".join(pop._environment_lines(env))
      and "NOT utf-8" not in "\n".join(pop._environment_lines(env)))
check("the desktop app version is read",
      env.get("desktop app") not in (None, "", "not readable"),
      str(env.get("desktop app")))
# Compared against the file, not against "looks like a version" -- hardcoding
# a plausible number passes a presence check and reports skew that is not there.
try:
    _pkg = json.loads(Path("/usr/lib/opencode-desktop/package.json").read_text())
    check("and it matches the desktop app's own package.json",
          env.get("desktop app") == _pkg.get("version"),
          f"report {env.get('desktop app')} vs package {_pkg.get('version')}")
except (OSError, ValueError):
    print("  skip  desktop package.json not readable")
check("the CLI the desktop app bundles is reported separately",
      "cli the desktop app bundles" in env)

# Pointed at fixtures rather than at this machine, whose three installs happen
# to agree. Comparing them to each other passes forever while any one of them
# is wrong; a fixture that disagrees does not.
check("a version file is read verbatim",
      pop._file_version(_write(tmp, "v.txt", "9.9.9\n")) == "9.9.9")
check("a package.json has its version field read, not its whole text",
      pop._file_version(_write(tmp, "p.json",
                               '{"name": "x", "version": "1.2.3"}')) == "1.2.3")
check("a missing file says so rather than reporting no version",
      pop._file_version(str(tmp / "absent")) == "not readable")
check("an unreadable file does not crash the report",
      pop._file_version(_write(tmp, "bad.json", "{not json")) == "not readable")
check("a file with no version reports unknown, not an empty line",
      pop._file_version(_write(tmp, "nov.json", '{"name": "x"}')) == "unknown")
check("each install reports its own number, not a shared one",
      len({env["desktop app"], env["cli the desktop app bundles"]} |
          {pop._file_version(_write(tmp, "other.txt", "0.0.1"))}) >= 2)
try:
    _cli = Path("/usr/lib/opencode-desktop/opencode-cli.version").read_text().strip()
    check("the bundled CLI version matches its version file",
          env.get("cli the desktop app bundles") == _cli,
          f"report {env.get('cli the desktop app bundles')} vs file {_cli}")
except OSError:
    print("  skip  cli version file not readable")
check("whatever opencode is on PATH is named",
      env["opencode_on_path"] != "")
check("the plugin script resolves to something",
      set(env["scripts"]) == {"session-list-popup"}
      and all(v for v in env["scripts"].values()))
check("memory is in MB and plausible",
      0 < env.get("mem_total", 0) < 10_000_000, str(env.get("mem_total")))
check("the schema is the one the store is reading", env["schema"] == store.table)

print("\nthe machine is identified, without being fingerprinted")
mach = pop._machine_info()
dmi = Path("/sys/class/dmi/id")
if dmi.is_dir():
    def _dmi(field):
        try:
            return (dmi / field).read_text().strip()
        except OSError:
            return ""
    check("the vendor is read from dmi", bool(mach.get("vendor")),
          str(mach.get("vendor")))
    check("the model is the name a person would use, not the type code",
          bool(mach.get("model")) and " " in mach["model"],
          str(mach.get("model")))
    check("and it matches what dmi actually reports, one of the two fields",
          mach.get("model") in (_dmi("product_version"), _dmi("product_name")),
          f"{mach.get('model')} vs {_dmi('product_name')!r} / {_dmi('product_version')!r}")
    check("the type code is kept separately rather than shown as the model",
          not mach.get("type") or mach.get("model") != mach["type"])
    # Placeholders, tested against the filter itself. Comparing a junk string
    # against this machine's vendor name passes whatever the filter does --
    # every DMI field here is genuinely populated.
    for junk in ("To Be Filled By O.E.M.", "Default string", "None",
                 "Unknown", "Not Applicable", "N/A", "System Serial Number",
                 "OEM", "  LENOVO  "):
        check(f"{junk!r} is {'kept' if junk.strip().lower() == 'lenovo' else 'treated as absent'}",
              pop._dmi_value(junk) == ("LENOVO" if junk.strip().lower() == "lenovo" else ""),
              repr(pop._dmi_value(junk)))
    check("a real value survives the filter", pop._dmi_value("LENOVO") == "LENOVO")

    # The two fields that identify the machine rather than describe it. Both
    # are root-only here, so this compares only when the file is readable --
    # `"" in str(...)` is always true, which is what made the first version of
    # this check fail against correct code.
    for field, label in (("product_serial", "serial number"),
                         ("product_uuid", "uuid")):
        value = _dmi(field)
        check(f"the {label} is not collected",
              not any(label.split()[0] in k.lower() for k in mach)
              and (value == "" or value not in str(mach.values())),
              f"dmi readable: {bool(value)}")

    # Structural, because on this machine those files are unreadable and the
    # check above cannot fail however the code reads them.
    _src = Path(pop.__file__).read_text()
    for field in ("product_serial", "product_uuid", "board_serial"):
        check(f"{field} is never read at all",
              f'field("{field}")' not in _src and f'"{field}"' not in _src)

    if mach.get("chassis"):
        check("the chassis is a known name, not a raw smbios number",
              mach["chassis"] in set(pop.CHASSIS_TYPES.values()),
              mach["chassis"])
        check("a laptop is recognisable as one",
              mach["chassis"] in {"laptop", "notebook", "portable",
                                  "convertible", "detachable", "sub notebook"},
              mach["chassis"])
else:
    print("  skip  /sys/class/dmi/id not present")

check("a machine with no dmi is reported as empty, not as a crash",
      isinstance(pop._machine_info(), dict))

print("\nthe cpu is named, and its real core count is not overstated")
cpu = pop._cpu_info()
check("the logical processor count is reported", isinstance(cpu.get("logical"), int)
      and cpu["logical"] > 0, str(cpu.get("logical")))
check("the model name is read from cpuinfo",
      bool(cpu.get("model")) or bool(cpu.get("arch")),
      str(cpu.get("model") or cpu.get("arch")))

# Physical cores worked out from /proc/cpuinfo independently, because the
# whole point is that os.cpu_count() CANNOT be trusted for this -- it returns
# logical processors and the report used to print that as "4 cpus" on a chip
# with two.
try:
    _txt = Path("/proc/cpuinfo").read_text()
    _pairs = set()
    for _block in _txt.split("\n\n"):
        _d = {}
        for _line in _block.splitlines():
            if ":" in _line:
                _k, _v = _line.split(":", 1)
                _d[_k.strip()] = _v.strip()
        if "core id" in _d and "physical id" in _d:
            _pairs.add((_d["physical id"], _d["core id"]))
    if _pairs:
        check("physical cores are counted, not assumed from the thread count",
              cpu.get("cores") == len(_pairs),
              f"report {cpu.get('cores')} vs cpuinfo {len(_pairs)}")
        check("and cores never exceed the logical count they came from",
              cpu["cores"] <= cpu["logical"], f"{cpu['cores']} / {cpu['logical']}")
except OSError:
    print("  skip  /proc/cpuinfo not readable")

# The summary must not overstate. On a hyperthreaded part the two differ, and
# that difference is the entire reason this probe exists.
summary = pop._cpu_summary(cpu)
check("the summary carries the model or the arch", bool(summary.strip()))
check("the clock speed is read and in a plausible range",
      isinstance(cpu.get("mhz"), float) and 100 < cpu["mhz"] < 10000,
      str(cpu.get("mhz")))
check("and the summary carries it in GHz", "GHz" in summary, summary)
if cpu.get("cores") and cpu.get("logical") and cpu["cores"] != cpu["logical"]:
    check("a hyperthreaded cpu says cores and threads, not just a count",
          f"{cpu['cores']} cores" in summary and f"{cpu['logical']} threads" in summary,
          summary)
    check("and does not present the thread count alone as the core count",
          not summary.startswith(str(cpu["logical"]) + " cores"))
check("the summary omits the model when asked, for the continuation line",
      (cpu.get("model") or "") not in pop._cpu_summary(cpu, with_model=False))
check("an unreadable cpu is reported as such rather than blank",
      pop._cpu_summary({}) == "not readable")
check("a one-core machine is not called multi-core",
      "1 core" in pop._cpu_summary({"logical": 1, "cores": 1}),
      pop._cpu_summary({"logical": 1, "cores": 1}))

print("\nthe environment section renders, and survives having no store")
lines = pop._environment_lines(env)
check("it carries display, versions and memory",
      any("display" in l for l in lines)
      and any("desktop app" in l for l in lines)
      and any("memory" in l for l in lines))
check("and names the cpu, which the report could not do before",
      any("cpu" in l for l in lines)
      and any((env.get("cpu", {}).get("model") or "x86") in l for l in lines),
      str([l for l in lines if "cpu" in l]))
check("and the rendered cpu line is not the bare thread count",
      not any(l.strip().startswith("cpus / load") and
              l.split()[2:3] == [str(os.cpu_count())] for l in lines))
_mach = env.get("machine") or {}
if _mach.get("model"):
    check("and names the machine, with the model and not just the vendor",
          any(_mach["model"] in l for l in lines),
          str([l for l in lines if "machine" in l]))
    check("and does not show the type code in place of the model",
          not any(l.split("machine", 1)[-1].strip().endswith(_mach.get("type", ""))
                  for l in lines if "machine" in l and _mach.get("type")))
else:
    check("a machine with no dmi still renders, just without the line",
          True)
check("the report has an ENVIRONMENT section",
      "ENVIRONMENT" in dict(pop.database_sections(d, store)))
check("and says so when there is no store to describe",
      "no store available" in str(
          dict(pop.database_sections(d, None)).get("ENVIRONMENT")))

print("\nmachine detail stays out of the per-session report")
sec_names = {h for h, _ in pop.session_sections(s) if h}
check("no ENVIRONMENT section on a session report",
      "ENVIRONMENT" not in sec_names, str(sorted(sec_names)))
check("no RUNNING PROCESSES section on a session report",
      "RUNNING PROCESSES" not in sec_names)
check("nothing about cpus, memory or usb on a session report",
      not any(word in " ".join(sec_names)
              for word in ("ENVIRONMENT", "PROCESS", "MACHINE", "USB")))

print("\nusb ports are read from sysfs")
ports = pop.usb_links()
check("it returns a list", isinstance(ports, list), f"{len(ports)} ports")

# Worked out from sysfs independently, because a list checked against itself
# is empty and therefore always true.
sysfs = Path("/sys/bus/usb/devices")
expected = set()
if sysfs.is_dir():
    for entry in sysfs.iterdir():
        if not entry.is_dir() or entry.name.startswith("usb"):
            continue
        if (entry / "speed").exists() or any(
                (e / "speed").exists() for e in entry.iterdir() if e.is_dir()):
            expected.add(entry.name.split(":")[0])
check("every port sysfs knows about is listed",
      {p["port"] for p in ports} == expected,
      f"{sorted({p['port'] for p in ports})} vs sysfs {sorted(expected)}")

if ports:
    check("controller roots are not listed as devices",
          not any(p["port"].startswith("usb") for p in ports),
          str([p["port"] for p in ports]))
    check("each port has a speed and a named generation",
          all(p["mbps"] > 0 and p["kind"] for p in ports))
    check("no port is listed twice",
          len({p["port"] for p in ports}) == len(ports))
    check("a 480 Mbps port is called USB 2.0",
          next((p["kind"] == "USB 2.0" for p in ports if p["mbps"] == 480), True),
          str([(p["mbps"], p["kind"]) for p in ports]))
    check("a 5000 Mbps port is called USB 3.0",
          next((p["kind"].startswith("USB 3") for p in ports
                if p["mbps"] >= 5000), True))

    # A mounted USB disk must be attributed to its port. Found independently,
    # because deriving the expectation from the ports that DO carry a disk
    # makes the check pass when none do.
    mounted_usb = set()
    for link in sorted(Path("/sys/class/block").glob("*")):
        if link.name.startswith(("loop", "ram", "zram", "dm-")):
            continue
        try:
            resolved = str(link.resolve())
        except OSError:
            continue
        if "/usb" in resolved and link.name:
            mounted_usb.add(link.name)
    if mounted_usb:
        named = {p.get("block") for p in ports if p.get("block")}
        check("a mounted usb disk is attributed to the port it sits on",
              bool(named & mounted_usb),
              f"disks {sorted(mounted_usb)} not attributed; ports name {sorted(n for n in named if n)}")

rendered_env = "\n".join(pop._environment_lines(env))
check("and they appear in the report", ports and "usb ports" in rendered_env)
check("with every port listed",
      all(f"{p['mbps']:,} Mbps" in rendered_env for p in ports))

print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
for name in FAIL:
    print(f"  failed: {name}")
shutil.rmtree(tmp, ignore_errors=True)
sys.exit(1 if FAIL else 0)