"""Read-only: where Alpha's failed sign-ins came from.

Usage: alpha_login_failures.py <auth_users.db> <audit_store.db> [hours]

Alpha records each failed sign-in in auth_security_events (address, client,
account) and each rate-limited one in audit_events. Both are opened read-only.
Called by check-alpha-logins.ps1.
"""
import sqlite3
import sys
from pathlib import Path


def query(db, sql):
    if not db.is_file():
        print(f"  (no database at {db})")
        return []
    con = sqlite3.connect(f"file:{db.as_posix()}?mode=ro", uri=True)
    try:
        return con.execute(sql).fetchall()
    except sqlite3.Error as exc:
        print(f"  (could not read {db}: {exc})")
        return []
    finally:
        con.close()


def main(argv):
    auth_db, audit_db = Path(argv[1]), Path(argv[2])
    hours = int(argv[3]) if len(argv) > 3 else 24
    since = f"datetime('now', '-{hours} hours')"

    print(f"Failed sign-ins, last {hours}h, by address / account / client (auth_security_events):")
    rows = query(auth_db, f"""
        select count(*), ip_address, username, substr(user_agent, 1, 70),
               min(created_at), max(created_at)
        from auth_security_events
        where event_type = 'login-failed' and replace(created_at, 'T', ' ') >= {since}
        group by 2, 3, 4 order by 1 desc limit 12""")
    for n, ip, user, agent, first, last in rows:
        print(f"  {n:6}  {ip or '?':16} {user or '?':12} {agent or '?'}  [{(first or '')[:19]} .. {(last or '')[:19]}]")
    if not rows:
        print("  none")

    print(f"Blocked sign-ins (rate limits), last {hours}h (audit_events):")
    rows = query(audit_db, f"""
        select count(*), ip, actor, detail, max(timestamp)
        from audit_events
        where action = 'login' and status = 'blocked' and replace(timestamp, 'T', ' ') >= {since}
        group by 2, 3, 4 order by 1 desc limit 8""")
    for n, ip, actor, detail, last in rows:
        print(f"  {n:6}  {ip or '?':16} {actor or '?':12} {detail}  [last {(last or '')[:19]}]")
    if not rows:
        print("  none")


if __name__ == "__main__":
    main(sys.argv)
