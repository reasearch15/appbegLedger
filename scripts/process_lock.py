"""Cross-platform singleton lock for long-running Telethon workers."""

from __future__ import annotations

import os
import sys
from pathlib import Path


class SyncWorkerLock:
    def __init__(self, session_path: Path, label: str = "account-sync"):
        self.session_path = Path(session_path)
        self.label = label
        self.lock_path = self.session_path.with_name(f"{self.session_path.name}.sync.lock")
        self._handle = None

    def read_holder_pid(self) -> str | None:
        if not self.lock_path.exists():
            return None
        try:
            return self.lock_path.read_text(encoding="utf-8").strip() or None
        except OSError:
            return None

    def _pid_running(self, pid: int) -> bool:
        try:
            os.kill(pid, 0)
        except OSError:
            return False
        return True

    def _try_acquire(self) -> bool:
        self.lock_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            self._handle = open(self.lock_path, "a+b")
            self._handle.seek(0)
            self._handle.write(b"\0")
            self._handle.flush()
            if sys.platform == "win32":
                import msvcrt

                msvcrt.locking(self._handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(self._handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            self._handle.seek(0)
            self._handle.truncate(0)
            self._handle.write(str(os.getpid()).encode("utf-8"))
            self._handle.flush()
            return True
        except OSError:
            if self._handle:
                try:
                    self._handle.close()
                except OSError:
                    pass
                self._handle = None
            return False

    def acquire(self) -> bool:
        if self._try_acquire():
            return True

        holder = self.read_holder_pid()
        if holder and holder.isdigit() and not self._pid_running(int(holder)):
            try:
                self.lock_path.unlink(missing_ok=True)
            except OSError:
                pass
            return self._try_acquire()

        return False

    def release(self) -> None:
        if not self._handle:
            return
        try:
            if sys.platform == "win32":
                import msvcrt

                msvcrt.locking(self._handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(self._handle.fileno(), fcntl.LOCK_UN)
        except OSError:
            pass
        try:
            self._handle.close()
        except OSError:
            pass
        self._handle = None
        try:
            if self.lock_path.exists():
                self.lock_path.unlink()
        except OSError:
            pass

    def already_running_message(self) -> str:
        holder = self.read_holder_pid()
        holder_text = f" (pid {holder})" if holder else ""
        return (
            f"[{self.label}:error] Another sync worker is already running{holder_text}. "
            f"Lock file: {self.lock_path}. "
            "Stop the other worker first. On Windows, stale local locks can be cleared with: "
            "taskkill /F /IM python.exe & taskkill /F /IM node.exe"
        )
