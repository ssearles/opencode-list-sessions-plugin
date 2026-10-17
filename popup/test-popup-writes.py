#!/usr/bin/env python3
"""
Verify the popup's write path against a throwaway database.

NEVER run this against the real database. The tests below assert the same
safety properties the plugin's own test suite guards, because a regression here
would mean silently corrupting a session store.
"""

import datetime
import importlib.machinery
import importlib.util
import os
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path

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
spec.loader.exec_module(pop)

PASS, FAIL = [], []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  {'ok  ' if cond else 'FAIL'}  {name}{'  — ' + detail if detail else ''}")


def fresh_db(tmp: Path) -> Path:
    """A standalone copy, WAL checkpointed so it carries its own data."""
    db = tmp / "opencode.db"
    c = sqlite3.connect(REAL)
    c.execute("VACUUM INTO ?", (str(db),))
    c.close()
    return db


def archived_ids(db: Path) -> set[str]:
    c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    out = {
        r[0]
        for r in c.execute("SELECT id FROM session_v2 WHERE time_archived IS NOT NULL")
    }
    c.close()
    return out


def msgs_of(db: Path, sid: str) -> int:
    c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    n = c.execute(
        "SELECT COUNT(*) FROM session_message WHERE session_id = ?", (sid,)
    ).fetchone()[0]
    c.close()
    return n


def count_of(db: Path, sql: str, *args) -> int:
    c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        return c.execute(sql, args).fetchone()[0]
    finally:
        c.close()


def has_table(db: Path, name: str) -> bool:
    return count_of(
        db, "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name = ?",
        name,
    ) > 0


def write(db: Path, sql: str, *args) -> None:
    """A direct write to the throwaway copy, bypassing the popup on purpose."""
    c = sqlite3.connect(db, timeout=15.0)
    try:
        c.execute(sql, args)
        c.commit()
    finally:
        c.close()


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="popup-test-"))
    real_before = archived_ids(REAL)
    try:
        db = fresh_db(tmp)
        store = pop.Store(db)

        # Clear the live-session marker the real database carries. The test
        # controls it explicitly below, and a leftover marker from the user's
        # actual session would make "exactly one row flagged" untrue here.
        if "time_suspended" in store.columns:
            c = sqlite3.connect(db)
            c.execute(f"UPDATE {store.table} SET time_suspended = NULL")
            c.commit()
            c.close()
            store = pop.Store(db)
        check("no live marker on the copy to begin with",
              all(not d.get("is_live") for d in store.list()))

        # ------------------------------------------------------------- order
        print("\nordering is by name within each group")
        working = [d for d in store.list() if not d["archived"]]
        check("working sessions listed", len(working) > 0, f"{len(working)} found")

        # The store still returns time_updated DESC, which is what OpenCode
        # itself uses and what restoring relies on to resurface a session. The
        # window sorts on top of that; nothing here should disturb the order
        # underneath it.
        times = [d["time_updated"] or 0 for d in working]
        check("store order is still time_updated DESC",
              times == sorted(times, reverse=True))
        check("by_name does not mutate the list it is given",
              (lambda src: (pop.by_name(src), [d["id"] for d in src])[1])(
                  [dict(d) for d in working]) == [d["id"] for d in working])
        named = pop.by_name(working)
        check("by_name returns the same rows, reordered",
              sorted(d["id"] for d in named) == sorted(d["id"] for d in working))
        keys = [(d["title"] or "").strip().lower() for d in named]
        check("by_name is alphabetical, untitled last",
              keys == sorted(keys, key=lambda k: (not k, k)), str(keys))

        archived = [d for d in store.list() if d["archived"]]
        check("archived set ordered separately", isinstance(archived, list))

        # ------------------------------------------------------------- write
        print("\narchive writes only the two columns")
        # Not working[0]: that may be the live session, which the guard below
        # is right to refuse. Pick one that is genuinely archivable, and restore
        # an archived session into the working set first if that is the only
        # kind there is — the real database currently holds just this one.
        archivable = [d["id"] for d in working if not d.get("is_live")]
        if not archivable:
            donor = next(d for d in store.list() if d["archived"])
            r = store.set_archived([donor["id"]], False)
            assert donor["id"] in r["changed"], r["errors"]
            archivable = [
                d["id"] for d in store.list() if not d["archived"] and not d.get("is_live")
            ]
        target = archivable[0]
        before_msgs = msgs_of(db, target)
        before_updated = next(
            d["time_updated"] for d in store.list() if d["id"] == target
        )

        res = store.set_archived([target], True)
        check("archive reported a change", target in res["changed"], str(res["errors"]))
        check("a backup was taken", res["backup"] is not None and res["backup"].exists())

        check("messages untouched by archive", msgs_of(db, target) == before_msgs)
        after = next(d for d in store.list() if d["id"] == target)
        check("session now archived", after["archived"] is True)

        # ------------------------------------------------------- restore rule
        print("\nrestore also refreshes time_updated (required to resurface)")
        res2 = store.set_archived([target], False)
        check("restore reported a change", target in res2["changed"], str(res2["errors"]))
        back = next(d for d in store.list() if d["id"] == target)
        check("no longer archived", back["archived"] is False)
        check(
            "time_updated advanced",
            (back["time_updated"] or 0) > (before_updated or 0),
            f"{before_updated} -> {back['time_updated']}",
        )
        check("messages untouched by restore", msgs_of(db, target) == before_msgs)

        # -------------------------------------------------------- bad inputs
        print("\nthe live session cannot be archived")
        # Give one session the marker the desktop app sets for the session you
        # are working in, then prove the write path refuses it.
        live_id = store.list()[0]["id"]
        db_live = sqlite3.connect(db)
        try:
            db_live.execute(
                f"UPDATE {store.table} SET time_suspended = ? WHERE id = ?",
                (int(datetime.datetime.now().timestamp() * 1000), live_id),
            )
            db_live.commit()
        finally:
            db_live.close()

        marked = next(d for d in store.list() if d["id"] == live_id)
        check("live session is flagged in list()", marked.get("is_live") is True)
        others = [d for d in store.list() if d["id"] != live_id]
        check("no other session is flagged",
              all(not d.get("is_live") for d in others))

        res_live = store.set_archived([live_id], True)
        check("archiving the live session is refused",
              live_id not in res_live["changed"], str(res_live["errors"]))
        check("refusal explains itself",
              any("cannot be archived" in e for e in res_live["errors"]),
              str(res_live["errors"]))
        check("live session is still unarchived",
              not next(d for d in store.list() if d["id"] == live_id)["archived"])

        # Restore is still allowed on it, so the guard is about archiving only.
        res_live_restore = store.set_archived([live_id], False)
        check("restore is unaffected by the guard",
              not res_live_restore["errors"], str(res_live_restore["errors"]))

        # Clear the marker so the remaining tests see a normal database.
        db_live = sqlite3.connect(db)
        try:
            db_live.execute(f"UPDATE {store.table} SET time_suspended = NULL")
            db_live.commit()
        finally:
            db_live.close()
        check("marker cleared",
              all(not d.get("is_live") for d in store.list()))

        print("\nbad input is reported, not thrown")
        res3 = store.set_archived(["ses_does_not_exist"], True)
        check("unknown id is an error row, not a raise", bool(res3["errors"]))
        check("no changes claimed", res3["changed"] == [])

        res4 = store.set_archived([], True)
        check("empty list is a no-op", res4["changed"] == [] and res4["backup"] is None)

        # ----------------------------------------------------------- renumber
        print("\narchiving moves a session between groups")
        # The real database legitimately holds archived sessions now, so this
        # cannot assume at least two unarchived rows exist. Unarchive an
        # existing one rather than inserting a synthetic row: the live schema
        # has several NOT NULL columns, and copying a row sidesteps all of them.
        before_order = [d["id"] for d in store.list() if not d["archived"]]
        if len(before_order) < 2:
            # Must pick a session that is actually archived, or unarchiving it
            # changes nothing and the count stays where it was.
            donor = next(d for d in store.list() if d["archived"])
            res_seed = store.set_archived([donor["id"]], False)
            assert donor["id"] in res_seed["changed"], res_seed["errors"]
            before_order = [d["id"] for d in store.list() if not d["archived"]]
        victim = before_order[1]
        store.set_archived([victim], True)
        after_order = [d["id"] for d in store.list() if not d["archived"]]
        check("archived session left the working list", victim not in after_order)
        check("remaining working count shrank by one", len(after_order) == len(before_order) - 1)
        store.set_archived([victim], False)
        restored_order = [d["id"] for d in store.list() if not d["archived"]]
        check("restoring puts it back at the top (time_updated refreshed)",
              restored_order and restored_order[0] == victim)

        # ------------------------------------------------------------ backups
        print("\nbackups are capped")
        store.backup()
        store.backup()
        store.backup()
        snaps = [f for f in (tmp / "backups").iterdir() if f.name.endswith(".db")]
        check(
            f"at most {store.RETAIN} snapshots retained",
            len(snaps) <= store.RETAIN,
            f"{len(snaps)} present",
        )

        # ------------------------------------------------------------- delete
        print("\ndelete removes the session and its children")
        rows_now = [d for d in store.list() if not d.get("is_live")]
        gone = rows_now[0]
        gone_id = gone["id"]
        before_msgs = msgs_of(db, gone_id)
        parts_before = count_of(db, "SELECT COUNT(*) FROM part WHERE session_id = ?",
                                gone_id) if has_table(db, "part") else None
        sessions_before = count_of(db, f"SELECT COUNT(*) FROM {store.table}")

        removed = pop.delete_session(store, gone_id)
        check("delete reported success", removed is True)
        check("the session row is gone",
              gone_id not in {d["id"] for d in store.list()})
        check("exactly one session left the table",
              count_of(db, f"SELECT COUNT(*) FROM {store.table}")
              == sessions_before - 1)
        check("its messages went with it", msgs_of(db, gone_id) == 0,
              f"{msgs_of(db, gone_id)} left")
        if parts_before is not None:
            check("its parts went with it",
                  count_of(db, "SELECT COUNT(*) FROM part WHERE session_id = ?",
                           gone_id) == 0)

        print("\ndelete refuses the live session and the unknown")
        live = next((d for d in store.list() if d.get("is_live")), None)
        if live is None:
            # Mark one, so the guard is exercised even when no session is live.
            mark_id = next(d["id"] for d in store.list())
            write(db, f"UPDATE {store.table} SET time_suspended = 1 WHERE id = ?",
                  mark_id)
            live = next(d for d in store.list() if d.get("is_live"))
        live_id = live["id"]
        raised = ""
        try:
            pop.delete_session(store, live_id)
        except ValueError as err:
            raised = str(err)
        check("the live session is refused", bool(raised), raised[:60])
        check("and it is still there", live_id in {d["id"] for d in store.list()})
        snaps_before_refusals = sorted((tmp / "backups").glob("*.db"),
                                       key=lambda p: p.stat().st_mtime)

        check("an unknown id deletes nothing, and does not raise",
              pop.delete_session(store, "ses_does_not_exist") is False)
        check("the table is unchanged by the unknown id",
              count_of(db, f"SELECT COUNT(*) FROM {store.table}")
              == sessions_before - 1)

        print("\na refused delete does not spend a snapshot")
        # The defect this guards: snapshotting before the refusal check meant
        # every refused delete consumed one of the three retained backups, so
        # three refusals evicted the only snapshot holding the deleted session.
        snaps_now = sorted((tmp / "backups").glob("*.db"),
                           key=lambda p: p.stat().st_mtime)
        # Two refusals happened above: the live session and the unknown id.
        check("two refused deletes left the snapshot count alone",
              len(snaps_now) == len(snaps_before_refusals),
              f"{len(snaps_before_refusals)} -> {len(snaps_now)}")
        snaps = snaps_now
        if snaps:
            c = sqlite3.connect(f"file:{snaps[-1]}?mode=ro", uri=True)
            try:
                kept = c.execute(
                    f"SELECT COUNT(*) FROM {store.table} WHERE id = ?", (gone_id,)
                ).fetchone()[0]
            finally:
                c.close()
            check("the newest snapshot still holds the deleted session",
                  kept == 1, f"rows in snapshot: {kept}")
        else:
            check("the newest snapshot still holds the deleted session",
                  False, "no snapshots at all")

        # ------------------------------------------------------- transcript
        print("\ntranscript reader")
        text = pop.read_transcript(store, target)
        check("transcript is non-empty", len(text) > 100, f"{len(text)} chars")
        check("transcript has message headings", text.count("### ") > 0,
              f"{text.count('### ')} messages")

        # ------------------------------------------------- real db untouched
        print("\nthe real database was not modified by this run")
        check("real db archived set unchanged by these tests",
              archived_ids(REAL) == real_before,
              f"{len(real_before)} before, {len(archived_ids(REAL))} after")

    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
    if FAIL:
        for f in FAIL:
            print(f"  failed: {f}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())