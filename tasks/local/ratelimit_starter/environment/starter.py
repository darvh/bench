import time

class RateLimiter:
    def __init__(self, max_calls: int, window_sec: float):
        self.max_calls = max_calls
        self.window_sec = window_sec
        self._calls = []

    def allow(self) -> bool:
        now = time.time()
        if len(self._calls) < self.max_calls:
            self._calls.append(now)
            return True
        return False
