"""Launcher для запуска Pi-агента.

Карточка be9cf712 (фаза 2, Pi = единый runtime): единая точка запуска
Pi-сессии. До этого момента Popen/env/цепочка сидели внутри
server/scripts/trigger.py:run_external и больше нигде. Теперь Pi
запускается ОДНИМ кодом:

  - trigger.py формирует структурированный spec (cmd, env, cwd,
    timeout, usage_path, agent_label) и вызывает popen_agent(spec).
  - PiRuntimeAdapter.startRun() (server/src/runtime/PiRuntimeAdapter.ts)
    запускает этот же скрипт через spawn(python3, [start_agent_run.py]),
    передаёт spec через stdin JSON, читает результат из stdout JSON.

Контракт:
  - вход (stdin или аргумент popen_agent): dict с полями ниже;
  - выход (stdout или возврат popen_agent): dict с полями ниже.

Никакого shell=True и никакой строковой конкатенации — только
argv-массив, передаваемый в Popen. Это не рекомендация, а жёсткое
правило: shell=True подставляет ENV процесса shell, что раскрывает
любой $VAR в cmd, и credential/env-фильтры (16.09.2026) перестают
работать.

credential НЕ логируется ни в одном из слоёв. В stderr пишем только
agent_label, task_id[:8], model, длительность — без текста задачи
и без ключей.

Поведение по умолчанию:
  - popen_agent валит на любой неожиданный ключ в spec (не молча
    игнорирует), чтобы trigger.py/Node-вызов не протащил лишнее.
  - Таймаут жёсткий: после timeout секунд процесс убивается, статус
    возврата = timeout.
  - kill_event (опциональный threading.Event) позволяет trigger.py /
    silence_watch прервать заход извне (SIGTERM). Статус результата
    в этом случае = killed.
  - Если usage_path указан и файл существует — он читается (JSON) и
    возвращается как usage (dict). Если нет — usage = None.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
from typing import Any

# Поля, которые принимает spec. Всё, чего нет в этом списке — ошибка
# валидации, чтобы trigger.py/Node-вызов не протащил лишнее по привычке.
_ALLOWED_SPEC_KEYS = frozenset({
    "cmd",
    "env",
    "cwd",
    "timeout",
    "agent_label",
    "usage_path",
    "kill_event",
})


def _validate_spec(spec: Any) -> dict:
    """Валидирует spec или кидает ValueError."""
    if not isinstance(spec, dict):
        raise ValueError(f"spec must be dict, got {type(spec).__name__}")
    unknown = set(spec) - _ALLOWED_SPEC_KEYS
    if unknown:
        raise ValueError(f"unknown spec keys: {sorted(unknown)}")
    cmd = spec.get("cmd")
    if not isinstance(cmd, list) or not cmd or not all(isinstance(c, str) and c for c in cmd):
        raise ValueError("spec.cmd must be non-empty list[str]")
    env = spec.get("env")
    if env is not None and not isinstance(env, dict):
        raise ValueError("spec.env must be dict[str, str] or None")
    cwd = spec.get("cwd")
    if cwd is not None and not isinstance(cwd, str):
        raise ValueError("spec.cwd must be str or None")
    timeout = spec.get("timeout", 3600)
    if not isinstance(timeout, int) or timeout <= 0:
        raise ValueError("spec.timeout must be positive int (seconds)")
    agent_label = spec.get("agent_label", "")
    if not isinstance(agent_label, str):
        raise ValueError("spec.agent_label must be str")
    usage_path = spec.get("usage_path")
    if usage_path is not None and not isinstance(usage_path, str):
        raise ValueError("spec.usage_path must be str or None")
    kill_event = spec.get("kill_event")
    if kill_event is not None and not isinstance(kill_event, threading.Event):
        raise ValueError("spec.kill_event must be threading.Event or None")
    return {
        "cmd": cmd,
        "env": env,
        "cwd": cwd,
        "timeout": timeout,
        "agent_label": agent_label,
        "usage_path": usage_path,
        "kill_event": kill_event,
    }


def _read_usage(path: str | None) -> dict | None:
    """Читает usage.json, который агент пишет сам в конце захода.

    Возвращает сырой dict или None, если файла нет / он не JSON.
    Файл после чтения удаляется — это мусор на один заход, не архив.
    Не логирует содержимое файла: там могут быть ключи/token'ы провайдера.
    """
    if not path:
        return None
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return None
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass
    return data if isinstance(data, dict) else None


def popen_agent(spec: dict) -> dict:
    """Один заход Pi.

    Args:
        spec: см. шапку модуля.

    Returns:
        dict с полями:
          - status: ok | timeout | killed | error
          - returncode: int | None (None если процесс не вернулся)
          - output_tail: str — последние 400 символов stdout
          - output_bytes: int — длина всего stdout (без хвоста)
          - usage: dict | None — содержимое usage.json если был
          - duration_sec: float
          - error: str | None — текст исключения если status=error
    """
    spec = _validate_spec(spec)
    cmd: list[str] = spec["cmd"]
    env: dict | None = spec["env"]
    cwd: str | None = spec["cwd"]
    timeout: int = spec["timeout"]
    agent_label: str = spec["agent_label"]
    usage_path: str | None = spec["usage_path"]
    kill_event: threading.Event | None = spec.get("kill_event")

    run_env = None
    if env is not None:
        # мердж с os.environ на уровне Popen — если env=None, наследуем всё
        run_env = {**os.environ, **env}

    started = time.monotonic()
    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            env=run_env,
            cwd=cwd,
        )
    except (OSError, ValueError) as exc:
        return {
            "status": "error",
            "returncode": None,
            "output_tail": "",
            "output_bytes": 0,
            "usage": None,
            "duration_sec": time.monotonic() - started,
            "error": f"{type(exc).__name__}: {exc}",
        }

    # kill_event позволяет trigger.py / silence_watch прервать заход
    # извне (SIGTERM). Отдельный поток ждёт Event и шлёт SIGTERM процессу;
    # communicate() ниже либо вернёт нормально (если процесс успел
    # выйти сам), либо получит TimeoutExpired.
    def _watch_kill() -> None:
        if kill_event is None:
            return
        if kill_event.wait(timeout=timeout + 5):
            try:
                proc.terminate()
            except OSError:
                pass

    watcher: threading.Thread | None = None
    if kill_event is not None:
        watcher = threading.Thread(target=_watch_kill, daemon=True)
        watcher.start()

    try:
        out, _ = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass
        return {
            "status": "timeout",
            "returncode": None,
            "output_tail": "",
            "output_bytes": 0,
            "usage": _read_usage(usage_path),
            "duration_sec": time.monotonic() - started,
            "error": f"timeout after {timeout}s",
        }
    except Exception as exc:  # noqa: BLE001 — задача 16.09.2026 (шаг 2)
        # communicate() упал по любой причине (broken pipe, OSError).
        # trigger.py пометит карточку как technical-failed.
        return {
            "status": "error",
            "returncode": proc.returncode,
            "output_tail": "",
            "output_bytes": 0,
            "usage": _read_usage(usage_path),
            "duration_sec": time.monotonic() - started,
            "error": f"{type(exc).__name__}: {exc}",
        }

    duration = time.monotonic() - started
    out_text = out or ""
    tail = out_text.strip()[-400:]
    # Если kill_event был установлен в ходе захода, маркируем как killed —
    # это сигнал trigger.py пометить карточку как silent-killed, а не как
    # обычное завершение.
    status = "ok"
    if kill_event is not None and kill_event.is_set():
        status = "killed"
    return {
        "status": status,
        "returncode": proc.returncode,
        "output_tail": tail,
        "output_bytes": len(out_text),
        "usage": _read_usage(usage_path),
        "duration_sec": duration,
        "error": None,
    }


def main() -> int:
    """Stdin/stdout JSON-режим для spawn из Node.

    Читает spec из stdin, пишет result в stdout. stderr — диагностика
    для разработчика (не идёт в Node). Код выхода: 0 всегда (ошибка
    самого запуска — в result.status)."""
    try:
        raw = sys.stdin.read()
    except OSError as exc:
        sys.stderr.write(f"start_agent_run: stdin read failed: {exc}\n")
        return 0
    try:
        spec = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError as exc:
        sys.stderr.write(f"start_agent_run: invalid JSON in stdin: {exc}\n")
        sys.stdout.write(json.dumps({
            "status": "error",
            "returncode": None,
            "output_tail": "",
            "output_bytes": 0,
            "usage": None,
            "duration_sec": 0.0,
            "error": f"invalid_spec: {exc}",
        }))
        return 0
    try:
        result = popen_agent(spec)
    except ValueError as exc:
        sys.stderr.write(f"start_agent_run: bad spec: {exc}\n")
        sys.stdout.write(json.dumps({
            "status": "error",
            "returncode": None,
            "output_tail": "",
            "output_bytes": 0,
            "usage": None,
            "duration_sec": 0.0,
            "error": f"bad_spec: {exc}",
        }))
        return 0
    sys.stdout.write(json.dumps(result, ensure_ascii=False))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
