import json
import os
from pathlib import Path
import pty
import signal
import subprocess
import sys
import tempfile
import termios
import time

binary = str(Path(sys.argv[1] if len(sys.argv) > 1 else "target/debug/xal-rust").resolve())

with tempfile.TemporaryDirectory(prefix="xal-native-terminal-") as root:
    env = dict(os.environ, HOME=root, XAL_HOME=root)
    env.pop("XAL_MODEL", None)
    for interrupt in [False, True]:
        master, slave = pty.openpty()
        original = termios.tcgetattr(slave)
        child = subprocess.Popen(
            [binary, "connect", "minimax", "Interrupted" if interrupt else "Unicode"],
            cwd=root, env=env, stdin=slave, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        try:
            deadline = time.monotonic() + 5
            while termios.tcgetattr(slave)[3] & termios.ECHO:
                if time.monotonic() > deadline or child.poll() is not None:
                    raise RuntimeError("hidden terminal input did not start")
                time.sleep(0.01)
            if interrupt:
                child.send_signal(signal.SIGINT)
            else:
                os.write(master, "éx\x7f\n".encode())
            stdout, stderr = child.communicate(timeout=5)
            if child.returncode != (130 if interrupt else 0):
                raise RuntimeError(f"terminal command failed: {child.returncode}: {stderr.decode()}")
            restored = termios.tcgetattr(slave)
            restored[3] &= ~termios.PENDIN
            original[3] &= ~termios.PENDIN
            if restored != original:
                raise RuntimeError("terminal mode was not restored")
            profiles = json.loads(Path(root, "credentials.json").read_text())["profiles"]
            if len(profiles) != 1 or next(iter(profiles.values()))["credential"]["key"] != "é":
                raise RuntimeError("UTF-8 backspace or cancelled connection changed credentials")
            if "é".encode() in stdout + stderr:
                raise RuntimeError("hidden credential leaked")
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()
            os.close(master)
            os.close(slave)
    child = subprocess.Popen(
        [binary, "run", "--model", "MiniMax-M2.7"], cwd=root, env=env,
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    try:
        time.sleep(0.1)
        child.send_signal(signal.SIGINT)
        if child.wait(timeout=5) != 130:
            raise RuntimeError("blocked piped stdin did not cancel")
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        child.communicate()

print("Hidden UTF-8 input, terminal restoration, and blocked-stdin cancellation passed")
