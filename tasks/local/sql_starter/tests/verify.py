import sqlite3, subprocess, sys
import starter
con = sqlite3.connect(":memory:")
con.execute("CREATE TABLE users (username TEXT)")
con.execute("INSERT INTO users VALUES ('alice')")
con.commit()
con.close()
attack = "alice' OR '1'='1"
try:
    r = starter.get_user(":memory:", attack)
    if r is not None and r != "alice":
        print("VERDICT=fail sql-injection-bypass"); sys.exit(1)
except Exception as e:
    if "unrecognized token" not in str(e).lower() and "syntax" not in str(e).lower():
        print("VERDICT=fail crashed"); sys.exit(1)
print("VERDICT=pass")
