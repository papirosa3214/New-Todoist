#!/usr/bin/env python3
"""Streaming MCP launcher using the existing vault-run resolve/scrub API.

The regular vault-run buffers output until the child exits, which deadlocks
stdio MCP. This launcher forwards each JSON line and redacts secret variants.
The credential stays in the worker environment, never argv or files.
"""
import importlib.util
import os
import signal
import subprocess
import sys
import threading


def main():
    if len(sys.argv) < 5:
        return 2
    vault_path, key, *command = sys.argv[1:]
    spec = importlib.util.spec_from_file_location("taskflow_vault", vault_path)
    vault = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(vault)
    value = vault.resolve(key)
    variants = vault.variants(value)
    env = dict(os.environ, COMPOSIO_API_KEY=value)
    child = subprocess.Popen(command, env=env, stdin=sys.stdin,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def forward(source, destination):
        for line in iter(source.readline, b""):
            destination.write(vault.scrub(line.decode("utf-8", errors="replace"), variants))
            destination.flush()

    def terminate(signum, _frame):
        if child.poll() is None:
            child.send_signal(signum)

    signal.signal(signal.SIGTERM, terminate)
    signal.signal(signal.SIGINT, terminate)
    streams = [threading.Thread(target=forward, args=(child.stdout, sys.stdout)),
               threading.Thread(target=forward, args=(child.stderr, sys.stderr))]
    for thread in streams:
        thread.start()
    result = child.wait()
    for thread in streams:
        thread.join()
    return result


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        print("Composio vault launcher unavailable", file=sys.stderr)
        sys.exit(1)
