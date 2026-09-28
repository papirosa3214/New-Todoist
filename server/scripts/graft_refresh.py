#!/usr/bin/env python3
"""
Пересборка графа проекта graft (описания разделов и файлов) локальной моделью.

ЗАЧЕМ. Карту кода (символы, file:line, вызовы) graft обновляет сам перед
каждым запросом. А описания — graft/*.md и сводки по файлам — собираются
только `graft build --deep` моделью; до 27.09.2026 их никто не пересобирал
с 10.09, и граф описывал проект двухнедельной давности.

КАК. Модель — основная локальная qwen3.6-27b в Ollama .110 (своих тегов под
сервисы не заводим — паспорт ~/.claude/models-local.md). Запуск:
  - ночью, graft-refresh.timer (01:00, окно без других потребителей карты);
  - по требованию: --if-stale (только если `graft check` говорит «устарел»).
Видеокарту чужой работы не отнимаем: --respect-gpu пропускает запуск, если
в Ollama уже загружена рабочая модель или карта занята.

ИТОГ — файл состояния ~/.local/state/graft-refresh/<name>.json; его читает
сторож graft_refresh_watch.py и пишет владельцу только о новой проблеме.

  python3 graft_refresh.py --repo ~/Проекты/New-Todoist --name server --if-stale --respect-gpu

Тот же скрипт гоняет и мак для графа iOS-клиента (Tools/graft-refresh.sh
забирает его отсюда по ssh — копии нет): пути задаются окружением
GRAFT_BIN / GRAFT_NODE_BIN / GRAFT_OLLAMA.
"""

from __future__ import annotations

import argparse
import re
import datetime as dt
import fcntl
import json
import os
import subprocess
import sys
import time
import urllib.request

HOME = os.path.expanduser("~")
STATE_DIR = os.path.join(HOME, ".local", "state", "graft-refresh")
NODE_BIN = os.environ.get("GRAFT_NODE_BIN") or os.path.join(HOME, ".nvm", "versions", "node", "v22.23.1", "bin")
GRAFT = os.environ.get("GRAFT_BIN") or os.path.join(HOME, ".npm-global", "bin", "graft")
OLLAMA = os.environ.get("GRAFT_OLLAMA", "http://127.0.0.1:11434")
# Запросы модели — через прокладку ~/infra-ops/ollama_nothink_shim.py (:11500):
# она дописывает reasoning_effort:"none". Владелец 27.09.2026: пересборку графа
# гонять с отключёнными рассуждениями — graft сам этого поля не шлёт, а с
# размышлениями два крошечных файла собирались 150 с.
LLM_URL = os.environ.get("GRAFT_LLM_URL", "http://127.0.0.1:11500")
MODEL = os.environ.get("GRAFT_REFRESH_MODEL", "qwen3.6-27b-iq4-16k:latest")
BUILD_TIMEOUT_S = 4 * 3600
# Сколько файлов может не описаться, прежде чем это тревога. В репозитории
# сервера лежат сторонние минифицированные vega*.min.js: один не влезает в
# контекст модели, на другом модель сбивается — они падают всегда, а исключить
# отслеживаемый git файл из графа graft не умеет (первый прогон 27.09.2026).
MAX_FAILED_FILES = 5
# Модели-эмбеддеры держатся в памяти постоянно и карту почти не грузят.
IDLE_MODELS = ("bge-m3-embed",)


def now() -> str:
    return dt.datetime.now().astimezone().isoformat(timespec="seconds")


def env_for_graft(base_url: str) -> dict:
    env = dict(os.environ)
    env["PATH"] = f"{NODE_BIN}:{os.path.dirname(GRAFT)}:{env.get('PATH', '')}"
    env.update(
        GRAFT_PROVIDER="openai",
        GRAFT_MODEL=MODEL,
        GRAFT_BASE_URL=f"{base_url}/v1",
        GRAFT_API_KEY="ollama",  # Ollama ключ не проверяет, протокол требует
        NO_PROXY="127.0.0.1,localhost,192.168.1.110",
        no_proxy="127.0.0.1,localhost,192.168.1.110",
    )
    return env


def gpu_busy() -> str | None:
    """Причина не запускаться, если карта занята чужой работой, иначе None.

    Занято — это (а) в Ollama загружена ДРУГАЯ рабочая модель (наша её бы
    вытеснила) или (б) карта реально нагружена. Наша же модель, загруженная и
    простаивающая, — не помеха: запросы пойдут в неё же (27.09.2026 первое
    правило «загружена любая = занято» пропускало запуск из-за собственного
    пробного прогона при нагрузке карты 0%).
    """
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(f"{OLLAMA}/api/ps", timeout=10) as r:
            loaded = [m["name"] for m in json.load(r).get("models", [])]
        others = [m for m in loaded if not m.startswith(IDLE_MODELS) and m != MODEL]
        if others:
            return "в Ollama работает другая модель: " + ", ".join(others)
    except Exception as e:  # Ollama не отвечает — модель всё равно недоступна
        return f"Ollama не отвечает: {e}"
    query = ["nvidia-smi", "--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"]
    gpu_ssh = os.environ.get("GRAFT_GPU_SSH")  # мак: карта на .110
    # Пять замеров за ~10 с, берём максимум: один замер попадал в паузу между
    # запросами чужой пересборки, и 27.09.2026 мак запустился параллельно с
    # сервером.
    sample = "for i in 1 2 3 4 5; do " + " ".join(query) + "; sleep 2; done"
    try:
        cmd = ["ssh", "-o", "BatchMode=yes", gpu_ssh, sample] if gpu_ssh else ["bash", "-c", sample]
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=40)
        util = max(int(x) for x in out.stdout.split() if x.strip().isdigit())
        if util > 30:
            return f"видеокарта занята (до {util}% за 10 с)"
    except Exception:
        pass
    return None


def graft_check(repo: str, env: dict) -> tuple[int, str]:
    out = subprocess.run([GRAFT, "check", repo], capture_output=True, text=True, env=env, timeout=600)
    first = (out.stdout or out.stderr).strip().splitlines()[:1]
    return out.returncode, (first[0] if first else "")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--if-stale", action="store_true")
    ap.add_argument("--respect-gpu", action="store_true")
    a = ap.parse_args()

    os.makedirs(STATE_DIR, exist_ok=True)
    status_path = os.path.join(STATE_DIR, f"{a.name}.json")
    log_path = os.path.join(STATE_DIR, f"{a.name}.log")
    lock = open(os.path.join(STATE_DIR, f"{a.name}.lock"), "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("пересборка уже идёт — выходим")
        return 0

    started = time.time()
    status = {"name": a.name, "repo": a.repo, "model": MODEL, "started_at": now()}

    def finish(result: str, detail: str, **extra) -> int:
        status.update(result=result, detail=detail, finished_at=now(),
                      duration_s=int(time.time() - started), **extra)
        json.dump(status, open(status_path, "w"), ensure_ascii=False, indent=2)
        print(f"{result}: {detail}")
        return 0 if result in ("ok", "fresh", "skipped") else 1

    env = env_for_graft(LLM_URL)
    if a.if_stale:
        code, line = graft_check(a.repo, env)
        if code == 0:
            return finish("fresh", "граф свежий, пересборка не нужна")
    if a.respect_gpu and (why := gpu_busy()):
        return finish("skipped", why)

    with open(log_path, "w") as log:
        log.write(f"{now()} graft build --deep {a.repo} ({MODEL})\n")
        log.flush()
        try:
            build = subprocess.run(
                # --allow-partial: несколько неописуемых файлов не валят всё;
                # сколько их — считаем сами ниже.
                [GRAFT, "build", "--deep", "--allow-partial", "-j", "1", a.repo],
                stdout=log, stderr=subprocess.STDOUT, env=env, timeout=BUILD_TIMEOUT_S,
            )
            build_exit = build.returncode
        except subprocess.TimeoutExpired:
            build_exit = -1

    log_text = open(log_path, errors="replace").read().replace("\r", "\n")
    code, line = graft_check(a.repo, env)
    concepts = re.search(r"✓ concepts: (\d+) nodes", log_text)
    coverage = re.search(r"meaning coverage: (\d+)/(\d+) symbols \((\d+)%\)", log_text)
    failed_files = re.findall(r"^✗ (?!the deep pass)([^:\n]+): ", log_text, re.M)
    facts = dict(build_exit=build_exit, check_exit=code,
                 concepts=int(concepts.group(1)) if concepts else None,
                 coverage_pct=int(coverage.group(3)) if coverage else None,
                 failed_files=failed_files)
    cov = f", сводки по символам {coverage.group(3)}%" if coverage else ""
    if build_exit != 0:
        tail = log_text.strip().splitlines()[-3:]
        why = "превышено 4 ч" if build_exit == -1 else f"код {build_exit}"
        return finish("failed", f"graft build --deep: {why}; " + " | ".join(tail), **facts)
    if not concepts:
        return finish("failed", "описания разделов не собраны (нет строки concepts в журнале)", **facts)
    if len(failed_files) > MAX_FAILED_FILES:
        return finish("failed", f"не описались {len(failed_files)} файлов: " + ", ".join(failed_files[:8]), **facts)
    skipped = f"; не описались: {', '.join(failed_files)}" if failed_files else ""
    return finish("ok", f"описания пересобраны: {concepts.group(1)} разделов{cov}{skipped}", **facts)


if __name__ == "__main__":
    sys.exit(main())
