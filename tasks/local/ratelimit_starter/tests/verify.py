import sys
import starter
rl = starter.RateLimiter(2, 60)
if not rl.allow() or not rl.allow() or rl.allow():
    print("VERDICT=fail burst-allowed"); sys.exit(1)
import time
rl2 = starter.RateLimiter(1, 0.05)
if not rl2.allow(): print("VERDICT=fail first-denied"); sys.exit(1)
time.sleep(0.08)
if not rl2.allow(): print("VERDICT=fail window-not-reset"); sys.exit(1)
print("VERDICT=pass")
