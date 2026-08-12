import os, tempfile, sys
import starter
d = tempfile.mkdtemp()
open(os.path.join(d, "ok.txt"), "w").write("fine")
secret = os.path.join(os.path.dirname(d), "secret.txt")
open(secret, "w").write("SECRET")
try:
    r = starter.read_file(d, "../" + os.path.basename(secret))
    if r == "SECRET":
        print("VERDICT=fail path-traversal"); sys.exit(1)
    if r != "fine":
        print("VERDICT=fail wrong-result"); sys.exit(1)
except Exception:
    pass
print("VERDICT=pass")
