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


def _session_with_an_image(db: Path) -> str | None:
    """The id of a session in the copy holding an inline image, if any."""
    c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        for sid, raw in c.execute(
                "SELECT session_id, data FROM session_message WHERE type = 'user'"):
            if '"files"' in raw and '"image/' in raw:
                return sid
        return None
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

        # The session standing in for "the one you are in" below. Any
        # unarchived session does now that the marker is cleared, and picking
        # it here rather than at use keeps every later block free to move the
        # timestamp wherever it needs to.
        current_id = next(d["id"] for d in store.list() if not d["archived"])

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
        print("\nthe session you are in is marked, not guessed")
        # `--current` is what the plugin passes, and it is authoritative. The
        # block below covers the fallback: pointed at a different session, the
        # window marks that one, and refuses to archive it.
        store = pop.Store(db, current=current_id)
        marked = next(d for d in store.list() if d["id"] == current_id)
        check("--current is marked in list()", marked.get("is_live") is True)
        check("--current is the only session marked",
              sum(1 for d in store.list() if d.get("is_live")) == 1)
        res = store.set_archived([current_id], True)
        check("--current cannot be archived",
              current_id not in res["changed"], str(res["errors"]))

        print("\na stale time_suspended does not override --current")
        # The exact failure this fixes: the timestamp points at the wrong
        # session -- because it is stale, or because the client guessed -- and
        # the window marked and refused that row instead of the live one.
        other_id = next(d["id"] for d in store.list() if d["id"] != current_id)
        db_stale = sqlite3.connect(db)
        try:
            db_stale.execute(f"UPDATE {store.table} SET time_suspended = NULL")
            db_stale.execute(
                f"UPDATE {store.table} SET time_suspended = ? WHERE id = ?",
                (int(datetime.datetime.now().timestamp() * 1000), other_id),
            )
            db_stale.commit()
        finally:
            db_stale.close()

        rows = store.list()
        check("--current wins over the timestamp",
              [d["id"] for d in rows if d.get("is_live")] == [current_id],
              str([d["title"] for d in rows if d.get("is_live")]))
        check("the stamped session is not marked instead",
              not next(d for d in rows if d["id"] == other_id).get("is_live"))
        db_chk = sqlite3.connect(db)
        try:
            check("the write path agrees with the marking",
                  store._is_live(db_chk, current_id)
                  and not store._is_live(db_chk, other_id))
        finally:
            db_chk.close()

        print("\nan empty --current behaves exactly like no --current")
        # list() tested `if not live_id` while _is_live() tested
        # `is not None`. An empty string satisfied one and not the other: the
        # window marked a row THIS SESSION while the write path refused
        # nothing, so the button said "cannot be archived" about a row it
        # would have archived. Normalised in Store.__init__.
        #
        # Asserted against a bare Store rather than against a fixed
        # expectation: the block above deliberately stamps `other_id`, so
        # falling back to that heuristic is correct, and the invariant is the
        # two agreeing, not either one marking nothing.
        empty = pop.Store(db, current="")
        bare = pop.Store(db)
        check("an empty --current is stored as absent",
              empty.current is None, repr(empty.current))
        rows_empty = empty.list()
        check("it marks the same row a bare Store marks",
              [d["id"] for d in rows_empty if d.get("is_live")]
              == [d["id"] for d in bare.list() if d.get("is_live")])
        db_empty = sqlite3.connect(db)
        try:
            # The failure was the refusal answering False where the bare Store
            # answers True, so compare both ways across every row rather than
            # only the marked one.
            check("the write path agrees with a bare Store on every row",
                  all(empty._is_live(db_empty, d["id"]) == bare._is_live(db_empty, d["id"])
                      for d in rows_empty))
        finally:
            db_empty.close()

        print("\nthe live session cannot be archived")
        # Give one session the marker the desktop app sets for the session you
        # are working in, then prove the write path refuses it. A bare Store,
        # as launched by hand, with no --current to go on.
        store = pop.Store(db)
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
        text, n_img, n_skip = pop.read_transcript(store, target)
        check("transcript is non-empty", len(text) > 100, f"{len(text)} chars")
        check("transcript has message headings", text.count("### ") > 0,
              f"{text.count('### ')} messages")

        print("\nimages are noted even when not extracted")
        # The failure this guards: a pasted screenshot is ~200KB of base64 in
        # the message's `files` list, and a reader that only looks at `text`
        # drops every one of them with no trace. A transcript of this session
        # had four screenshots in it and contained none of them.
        check("image counts are returned", isinstance(n_img, int) and isinstance(n_skip, int),
              f"{n_img} written, {n_skip} skipped")
        check("nothing is written when no directory is given", n_img == 0)

        img_sid = _session_with_an_image(db)
        if img_sid:
            check("a message with an inline image exists in the copy", True, img_sid)
            text2, _, _ = pop.read_transcript(store, img_sid)
            check("the image is mentioned, not silently dropped",
                  "[image:" in text2,
                  "no placeholder and no reference in the transcript")

            assets = tmp / "assets-test"
            text3, written3, _ = pop.read_transcript(store, img_sid, assets_dir=assets)
            check("with a directory the image is decoded to a file", written3 >= 1,
                  f"{written3} written")
            files = sorted(p.name for p in assets.iterdir()) if assets.exists() else []
            check("the file is a real PNG", bool(files) and files[0].endswith(".png"),
                  str(files))
            if files:
                head = (assets / files[0]).read_bytes()[:8]
                check("and its bytes are a PNG, not base64 text",
                      head == b"\x89PNG\r\n\x1a\n", repr(head))
                check("the transcript references it relatively",
                      f"{assets.name}/{files[0]}" in text3,
                      "no relative link in the markdown")
        else:
            check("a message with an inline image exists in the copy", True,
                  "skipped: none in this copy")

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