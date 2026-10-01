#!/usr/bin/env python3
"""CLI-клиент общей подготовки задач. Не создаёт карточки и не запускает роли.

Использует адрес API и авторизацию существующего mcp_server.py.
Пример: python3 scripts/task_prepare.py --text 'Подготовь инструкцию'
"""
import argparse
import json
import sys
from pathlib import Path
import mcp_server


def main():
    parser = argparse.ArgumentParser(description="Подготовить предложение задачи без записи и запуска")
    inputs = parser.add_mutually_exclusive_group(required=True)
    inputs.add_argument("--text")
    inputs.add_argument("--input", help="UTF-8 файл; '-' для stdin")
    parser.add_argument("--context", default="")
    parser.add_argument("--source-record-id")
    args = parser.parse_args()
    text = args.text if args.text is not None else (
        sys.stdin.read() if args.input == "-" else Path(args.input).read_text(encoding="utf-8")
    )
    try:
        mcp_server.TOKEN = mcp_server.load_token()
        result = mcp_server.t_structure_dictation({
            "text": text, "context": args.context, "source_record_id": args.source_record_id,
        })
    except mcp_server.TaskFlowError as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
