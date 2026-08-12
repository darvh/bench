import sqlite3

def get_user(db_path: str, username: str):
    con = sqlite3.connect(db_path)
    cur = con.execute("SELECT name FROM users WHERE username = '%s'" % username)
    row = cur.fetchone()
    con.close()
    return row[0] if row else None
