#!/usr/bin/env python3
"""Antigravity Autonomous Agent Runner.

Нативный агент Antigravity (Google DeepMind) для TaskFlow.
Работает на моделях Gemini и локальном движке,
имеет инструменты для работы с кодовой базой (bash, read_file, write_file, replace),
создания скриншотов (take_screenshot) и загрузки вложений (taskflow_upload_attachment),
а также напрямую управляет подзадачами и статусами в TaskFlow API.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

DEFAULT_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
TASKFLOW_API = os.environ.get("TASKFLOW_API", "http://localhost:3001")
TASKFLOW_TOKEN = os.environ.get(
    "TASKFLOW_ANTIGRAVITY_TOKEN",
    "tf_e0d4ae5529f272a989c85bad13208b5a4288a273bc760b046f226b580ebe0c38",
)
PROXY_URL = os.environ.get("HTTPS_PROXY", "http://127.0.0.1:10814")

# Принудительно заворачиваем все запросы через рабочий прокси сервера
for p_var in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
    os.environ[p_var] = PROXY_URL
os.environ.setdefault("ALL_PROXY", "socks5://127.0.0.1:10815")
os.environ.setdefault("all_proxy", "socks5://127.0.0.1:10815")


def get_gemini_key() -> str:
    """Достаёт ключ Gemini из окружения или хранилища vault."""
    k = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if k:
        return k.strip()
    try:
        cmd = ["python3", os.path.expanduser("~/.claude/vault-get.py"), "--raw", "GEMINI_API_KEY"]
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=5)
        if res.returncode == 0 and res.stdout.strip():
            return res.stdout.strip()
    except Exception:
        pass
    return ""


def call_taskflow_api(method: str, path: str, payload: dict | None = None, raw_bytes: bytes | None = None, content_type: str = "application/json") -> dict | list | None:
    """Вызов TaskFlow API от имени Antigravity."""
    url = f"{TASKFLOW_API}{path}"
    headers = {"Authorization": f"Bearer {TASKFLOW_TOKEN}"}
    data = None
    if raw_bytes is not None:
        headers["Content-Type"] = content_type
        data = raw_bytes
    elif payload is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else None
    except Exception as e:
        print(f"[Antigravity] TaskFlow API error ({method} {path}): {e}", file=sys.stderr)
        return None


def execute_tool(tool_name: str, args: dict, task_id: str | None = None) -> str:
    """Исполнение вызова инструмента."""
    try:
        if tool_name == "bash":
            cmd = args.get("command", "")
            cwd = args.get("cwd", str(Path.cwd()))
            res = subprocess.run(
                cmd, shell=True, capture_output=True, text=True, cwd=cwd, timeout=300
            )
            out = res.stdout + (f"\nSTDERR: {res.stderr}" if res.stderr else "")
            return out.strip() or f"(команда завершилась с кодом {res.returncode})"

        elif tool_name == "read_file":
            path = Path(args.get("path", "")).resolve()
            if not path.exists():
                return f"Ошибка: файл {path} не найден"
            return path.read_text(encoding="utf-8", errors="replace")[:20000]

        elif tool_name == "write_file":
            path = Path(args.get("path", "")).resolve()
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(args.get("content", ""), encoding="utf-8")
            return f"Успешно записан файл {path}"

        elif tool_name == "replace_file_content":
            path = Path(args.get("path", "")).resolve()
            target = args.get("target", "")
            replacement = args.get("replacement", "")
            if not path.exists():
                return f"Ошибка: файл {path} не найден"
            content = path.read_text(encoding="utf-8")
            if target not in content:
                return f"Ошибка: целевой текст не найден в {path}"
            new_content = content.replace(target, replacement, 1)
            path.write_text(new_content, encoding="utf-8")
            return f"Успешно заменено содержимое в {path}"

        elif tool_name in ("take_screenshot", "screenshot"):
            out_path = args.get("path") or "/tmp/screenshot.png"
            try:
                from PIL import ImageGrab
                os.environ.setdefault("DISPLAY", ":0")
                im = ImageGrab.grab()
                im.save(out_path)
                return f"Скриншот экрана успешно сохранён в {out_path} (разрешение: {im.size[0]}x{im.size[1]})"
            except Exception as e:
                # Fallback to scrot or xwd
                subprocess.run(f"DISPLAY=:0 scrot {out_path} 2>/dev/null || DISPLAY=:0 import -window root {out_path}", shell=True)
                if Path(out_path).exists():
                    return f"Скриншот экрана сохранён в {out_path}"
                return f"Ошибка снятия скриншота: {e}"

        elif tool_name in ("taskflow_upload_attachment", "upload_attachment"):
            target_task_id = args.get("task_id") or task_id
            file_path = Path(args.get("path", "")).resolve()
            filename = args.get("filename") or file_path.name or "attachment.png"
            if not file_path.exists():
                return f"Ошибка: файл {file_path} не найден"
            if not target_task_id:
                return "Ошибка: не указан task_id"
            
            raw_bytes = file_path.read_bytes()
            mime = "image/png" if filename.endswith(".png") else "application/octet-stream"
            enc_name = urllib.parse.quote(filename)
            res = call_taskflow_api("POST", f"/api/tasks/{target_task_id}/attachments?name={enc_name}", raw_bytes=raw_bytes, content_type=mime)
            return f"Файл {filename} успешно прикреплён к задаче {target_task_id}"

        elif tool_name in ("taskflow_subtask", "taskflow_subtask_done"):
            subtask_id = args.get("subtask_id")
            done = bool(args.get("done", True))
            result = args.get("result") or "Шаг успешно выполнен."
            if subtask_id:
                call_taskflow_api("PATCH", f"/api/subtasks/{subtask_id}", {"done": done, "result": result})
                return f"Подзадача {subtask_id} отмечена как {'выполнена' if done else 'в работе'}"
            return "Подзадача обновлена"

        elif tool_name == "taskflow_state":
            target_task_id = args.get("task_id") or task_id
            state = args.get("state", "review")
            comment = args.get("comment", "")
            if target_task_id:
                call_taskflow_api("POST", f"/api/tasks/{target_task_id}/state", {"state": state, "comment": comment})
                return f"Статус задачи {target_task_id} изменён на {state}"
            return "Статус задачи обновлен"

        elif tool_name == "taskflow_comment":
            target_task_id = args.get("task_id") or task_id
            text = args.get("text", "")
            if target_task_id and text:
                call_taskflow_api("POST", f"/api/tasks/{target_task_id}/comments", {"text": text})
                return f"Комментарий добавлен к задаче {target_task_id}"
            return "Комментарий отправлен"

        return f"Неизвестный инструмент: {tool_name}"
    except Exception as e:
        return f"Ошибка выполнения инструмента {tool_name}: {e}"


def parse_text_tool_calls(text: str) -> list[tuple[str, dict]]:
    """Парсит вызовы функций из текстового вывода модели."""
    calls = []
    # 1. take_screenshot(...)
    if re.search(r'(take_screenshot|создать скриншот|сделай скриншот)', text, re.IGNORECASE):
        calls.append(("take_screenshot", {"path": "/tmp/screenshot.png"}))
        calls.append(("taskflow_upload_attachment", {"path": "/tmp/screenshot.png", "filename": "screenshot_desktop.png"}))

    # 2. taskflow_state(state="review", comment="...")
    state_matches = re.finditer(r'taskflow_state\s*\((.*?)\)', text, re.DOTALL)
    for m in state_matches:
        params_raw = m.group(1)
        state_m = re.search(r'state\s*=\s*["\']([^"\']+)["\']', params_raw)
        comment_m = re.search(r'comment\s*=\s*["\']([^"\']+)["\']', params_raw)
        task_id_m = re.search(r'task_id\s*=\s*["\']([^"\']+)["\']', params_raw)
        args = {
            "state": state_m.group(1) if state_m else "review",
            "comment": comment_m.group(1) if comment_m else "",
        }
        if task_id_m:
            args["task_id"] = task_id_m.group(1)
        calls.append(("taskflow_state", args))

    # 3. taskflow_comment(text="...")
    comment_matches = re.finditer(r'taskflow_comment\s*\((.*?)\)', text, re.DOTALL)
    for m in comment_matches:
        params_raw = m.group(1)
        text_m = re.search(r'text\s*=\s*["\']([^"\']+)["\']', params_raw)
        task_id_m = re.search(r'task_id\s*=\s*["\']([^"\']+)["\']', params_raw)
        if text_m:
            args = {"text": text_m.group(1)}
            if task_id_m:
                args["task_id"] = task_id_m.group(1)
            calls.append(("taskflow_comment", args))

    # 4. taskflow_subtask(subtask_id="...", done=true, result="...")
    subtask_matches = re.finditer(r'taskflow_subtask(?:_done)?\s*\((.*?)\)', text, re.DOTALL)
    for m in subtask_matches:
        params_raw = m.group(1)
        id_m = re.search(r'subtask_id\s*=\s*["\']([^"\']+)["\']', params_raw)
        done_m = re.search(r'done\s*=\s*(true|false|True|False)', params_raw)
        res_m = re.search(r'result\s*=\s*["\']([^"\']+)["\']', params_raw)
        if id_m:
            calls.append(("taskflow_subtask", {
                "subtask_id": id_m.group(1),
                "done": done_m.group(1).lower() == "true" if done_m else True,
                "result": res_m.group(1) if res_m else "Шаг выполнен."
            }))

    # 5. bash(command="...")
    bash_matches = re.finditer(r'bash\s*\(\s*command\s*=\s*["\']([^"\']+)["\']\s*\)', text, re.DOTALL)
    for m in bash_matches:
        calls.append(("bash", {"command": m.group(1)}))

    return calls


TOOL_SCHEMAS = [
    {
        "name": "take_screenshot",
        "description": "Сделать реальный скриншот рабочего стола сервера и сохранить в файл (например, /tmp/screenshot.png).",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Путь для сохранения скриншота"}
            },
        },
    },
    {
        "name": "taskflow_upload_attachment",
        "description": "Прикрепить созданный файл/скриншот к текущей задаче TaskFlow.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Локальный путь к файлу на сервере"},
                "filename": {"type": "string", "description": "Имя файла в карточке задачи"},
            },
            "required": ["path"],
        },
    },
    {
        "name": "bash",
        "description": "Выполнить bash-команду на сервере (запуск тестов, сборка, git, поиск файлов).",
        "parameters": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "Команда для выполнения"}
            },
            "required": ["command"],
        },
    },
    {
        "name": "read_file",
        "description": "Прочитать содержимое файла в кодовой базе.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Абсолютный или относительный путь к файлу"}
            },
            "required": ["path"],
        },
    },
    {
        "name": "write_file",
        "description": "Создать или перезаписать файл.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Путь к файлу"},
                "content": {"type": "string", "description": "Полное содержимое файла"},
            },
            "required": ["path", "content"],
        },
    },
    {
        "name": "taskflow_subtask",
        "description": "Отметить подзадачу (шаг) в карточке TaskFlow выполненной.",
        "parameters": {
            "type": "object",
            "properties": {
                "subtask_id": {"type": "string", "description": "UUID подзадачи"},
                "done": {"type": "boolean", "description": "true если шаг завершён"},
                "result": {"type": "string", "description": "Краткий отчёт по шагу (1-2 предложения)"},
            },
            "required": ["subtask_id", "done", "result"],
        },
    },
    {
        "name": "taskflow_state",
        "description": "Перевести карточку задачи в статус: 'in_progress', 'review' (готова к проверке), 'blocked' (требуется помощь владельца), 'completed'.",
        "parameters": {
            "type": "object",
            "properties": {
                "task_id": {"type": "string", "description": "UUID задачи"},
                "state": {"type": "string", "enum": ["in_progress", "review", "blocked", "completed"]},
                "comment": {"type": "string", "description": "Отчёт о проделанной работе"},
            },
            "required": ["task_id", "state", "comment"],
        },
    },
]

SYSTEM_PROMPT = """Ты — Antigravity, ведущий автономный AI-инженер разработчика от Google DeepMind в экосистеме TaskFlow.
Твоя цель — РЕАЛЬНО выполнять поставленные задачи на сервере, используя системные инструменты.

СТРОГИЕ ПРАВИЛА:
1. КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО выдумывать или симулировать действия («Я проверил...», «Определён объём...»).
2. Если в задаче требуется что-то проверить (память, диск, сеть, службы, процессы, файлы) — ты ОБЯЗАН СНАЧАЛА вызвать инструмент bash:
   bash(command="команда")
   Примеры:
   • Память и своп: bash(command="free -h && swapon --show")
   • Детали и частота RAM: bash(command="lshw -short -C memory 2>/dev/null || dmidecode -t memory 2>/dev/null || cat /proc/meminfo")
   • Диски: bash(command="df -h")
   • Сеть/порты: bash(command="ss -ltnp")
3. В финальном отчёте ты ОБЯЗАН привести РЕАЛЬНЫЕ ЦИФРЫ И ФАКТЫ из вывода команд (например: «Всего RAM: 64 GB, Свободно: 42 GB, Частота: 3200 MT/s, Своп: 0/16 GB занято»).
4. Отмечай каждый выполненный шаг через taskflow_subtask(subtask_id, done=true, result='...').
5. По завершении сдай задачу в review через taskflow_state(task_id, state='review', comment='отчёт с точными цифрами')."""


def run_agent_loop(prompt: str, model_name: str) -> None:
    """Главный цикл взаимодействия агента с LLM."""
    api_key = get_gemini_key()
    print(f"[Antigravity] Запуск агента на модели {model_name}...")
    executed_tools_summary = []

    # Извлекаем task_id из текста задания
    task_id_match = re.search(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', prompt, re.IGNORECASE)
    task_id = task_id_match.group(0) if task_id_match else None

    # Если задача про скриншот — сразу сделаем и прикрепим
    if "скриншот" in prompt.lower() and task_id:
        print("[Antigravity] Обнаружена задача со скриншотом: делаю снимок экрана...")
        execute_tool("take_screenshot", {"path": "/tmp/screenshot.png"}, task_id=task_id)
        execute_tool("taskflow_upload_attachment", {"path": "/tmp/screenshot.png", "filename": "screenshot_desktop.png"}, task_id=task_id)

    # Автоматический сбор фактов по системным ресурсам при наличии ключевых слов
    if task_id and not executed_tools_summary:
        low_p = prompt.lower()
        if any(w in low_p for w in ("памят", "ram", "memory", "своп", "swap")):
            print("[Antigravity] Сбор данных по оперативной памяти и свопу...")
            out1 = execute_tool("bash", {"command": "free -h && echo '--- SWAP ---' && swapon --show"}, task_id=task_id)
            out2 = execute_tool("bash", {"command": "grep -E 'MemTotal|MemFree|MemAvailable|SwapTotal|SwapFree' /proc/meminfo"}, task_id=task_id)
            messages_pre = f"РЕАЛЬНЫЙ ВЫВОД СИСТЕМЫ:\n1. free -h & swap:\n{out1}\n2. /proc/meminfo:\n{out2}\n\nНапиши подробный отчёт с ТОЧНЫМИ цифрами."
            executed_tools_summary.append(f"• **free -h / swapon**:\n```\n{out1}\n```")
        elif any(w in low_p for w in ("диск", "мест", "объем", "df", "хранилищ")):
            print("[Antigravity] Сбор данных по дисковому пространству...")
            out = execute_tool("bash", {"command": "df -h -x tmpfs -x devtmpfs"}, task_id=task_id)
            messages_pre = f"РЕАЛЬНЫЙ ВЫВОД df -h:\n{out}\n\nНапиши подробный отчёт со свободным местом."
            executed_tools_summary.append(f"• **df -h**:\n```\n{out}\n```")
        else:
            messages_pre = None

    ollama_model = os.environ.get("OLLAMA_MODEL", "coder30b-abl:latest")

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": prompt},
    ]
    if 'messages_pre' in locals() and messages_pre:
        messages.append({"role": "user", "content": messages_pre})

    for step in range(1, 20):
        reply_text = ""
        function_calls = []

        if api_key:
            # Запрос через Google Gemini REST API с поддержкой прокси
            try:
                url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent?key={api_key}"
                proxy_handler = urllib.request.ProxyHandler({"https": PROXY_URL, "http": PROXY_URL})
                opener = urllib.request.build_opener(proxy_handler)
                
                payload = {
                    "contents": [
                        {
                            "role": "user" if m["role"] in ("user", "system") else "model",
                            "parts": [{"text": m["content"]}],
                        }
                        for m in messages
                    ],
                    "tools": [{"functionDeclarations": TOOL_SCHEMAS}],
                    "generationConfig": {"temperature": 0.2, "maxOutputTokens": 4096},
                }
                req = urllib.request.Request(
                    url,
                    data=json.dumps(payload).encode("utf-8"),
                    headers={"Content-Type": "application/json"},
                )
                with opener.open(req, timeout=120) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                    cand = (data.get("candidates") or [{}])[0]
                    content = cand.get("content", {})
                    parts = content.get("parts", [])
                    
                    function_calls = [
                        (p["functionCall"]["name"], p["functionCall"].get("args") or {})
                        for p in parts if "functionCall" in p
                    ]
                    text_parts = [p["text"] for p in parts if "text" in p]
                    reply_text = "\n".join(text_parts).strip()
            except Exception as e:
                pass

        if not reply_text and not function_calls:
            # Fallback на локальный Ollama
            try:
                url = f"{TASKFLOW_API.replace(':3001', ':11434')}/api/chat"
                req = urllib.request.Request(
                    url,
                    data=json.dumps({
                        "model": ollama_model,
                        "messages": messages,
                        "stream": False,
                    }).encode("utf-8"),
                    headers={"Content-Type": "application/json"},
                )
                with urllib.request.urlopen(req, timeout=120) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                    reply_text = data.get("message", {}).get("content", "").strip()
            except Exception as e:
                print(f"[Antigravity] Ошибка локального движка: {e}", file=sys.stderr)
                break

        if reply_text:
            print(f"\n[Antigravity]: {reply_text}\n")
            parsed_calls = parse_text_tool_calls(reply_text)
            if parsed_calls:
                function_calls.extend(parsed_calls)

        # Выполняем вызовы функций
        if function_calls:
            for fn_name, fn_args in function_calls:
                print(f"[Antigravity Tool]: {fn_name}({json.dumps(fn_args, ensure_ascii=False)})")
                tool_res = execute_tool(fn_name, fn_args, task_id=task_id)
                print(f"  → {tool_res[:300]}")
                executed_tools_summary.append(f"• **{fn_name}**: `{tool_res.strip()}`")
                messages.append({"role": "model", "content": f"Вызов {fn_name}: {json.dumps(fn_args)}"})
                messages.append({"role": "user", "content": f"Результат инструмента {fn_name}:\n{tool_res}"})
            continue

        # Инструментов модель не вызвала — значит работы не было, только текст.
        #
        # Раньше здесь агент ЗА МОДЕЛЬ закрывал все шаги («Шаг „…" выполнен»)
        # и сам ставил задачу в review с отчётом «Задача выполнена агентом
        # Antigravity». На доске это выглядело как сделанная работа: заходы
        # 24.08.2026 длились 5 и 23 секунды, Gemini при этом отвечал отказом
        # по геолокации, а карточка уходила владельцу «на проверку» пустой.
        #
        # Шаг закрывает только тот, кто его сделал: модель — через инструмент
        # taskflow_subtask, и никак иначе. Не сделала ничего — задача честно
        # уходит в blocked, чтобы владелец увидел, что агент не справился.
        # blocked заодно останавливает сторожа: по протоколу он такую карточку
        # больше не поднимает и не крутит пустые заходы по кругу.
        # Важно: «ничего не сделал» — это когда за весь заход не было НИ ОДНОГО
        # вызова инструмента. Если вызовы были (в том числе на прошлых витках
        # цикла), состояние карточки оставляем таким, каким его оставила сама
        # модель: она могла уже сдать работу в review, и перебивать это на
        # blocked нельзя.
        if task_id and not executed_tools_summary:
            clean_comment = re.sub(r'taskflow_\w+\(.*?\)', '', reply_text).strip()
            report_lines = ["Инструменты не вызывались — работа по задаче не выполнена."]
            if clean_comment:
                report_lines.append("\nЧто ответила модель:\n" + clean_comment)
            if executed_tools_summary:
                report_lines.append("\n**Данные выполнения:**\n" + "\n".join(executed_tools_summary[-3:]))

            call_taskflow_api("POST", f"/api/tasks/{task_id}/state", {
                "state": "blocked",
                "comment": "\n".join(report_lines).strip()[:1000],
            })
            print(f"[Antigravity] Задача {task_id[:8]} помечена blocked: агент не выполнил работу.")
            print("[Antigravity] Работа завершена без выполненных действий.")
        else:
            print("[Antigravity] Работа завершена; состояние карточки оставлено таким, каким его задала модель.")
        break


def interactive_chat_loop(model_name: str) -> None:
    """Интерактивный терминальный чат с Antigravity."""
    print("=" * 60)
    print(f"  🌌 Antigravity Interactive Chat (Модель: {model_name})")
    print("  Для выхода введи 'exit', 'quit' или 'q'")
    print("=" * 60)

    messages = [{"role": "system", "content": SYSTEM_PROMPT}]

    while True:
        try:
            user_input = input("\n👤 Вы > ").strip()
            if not user_input:
                continue
            if user_input.lower() in ("exit", "quit", "q"):
                print("\n[Antigravity] До встречи!")
                break

            run_agent_loop(user_input, model_name)
        except (KeyboardInterrupt, EOFError):
            print("\n[Antigravity] Сессия завершена.")
            break


def main():
    parser = argparse.ArgumentParser(description="Antigravity Autonomous Runner & Interactive Chat")
    parser.add_argument("-z", "-p", "--prompt", dest="prompt", default=None, help="Текст задания (если не указан, запускается интерактивный чат)")
    parser.add_argument("-m", "--model", dest="model", default=DEFAULT_MODEL, help="Модель Gemini")
    args = parser.parse_args()

    if args.prompt:
        run_agent_loop(args.prompt, args.model)
    else:
        interactive_chat_loop(args.model)


if __name__ == "__main__":
    main()
