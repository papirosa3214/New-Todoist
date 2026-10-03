import json
import re
from pathlib import Path
CONTRACT = json.loads((Path(__file__).resolve().parent.parent / "shared/task-brief.json").read_text(encoding="utf-8"))
INSTRUCTIONS = CONTRACT["instructions"]

def instruction(key, text):
    if key in ("tool.mcp.taskflow_create_task", "mcp.initialize") and INSTRUCTIONS not in text:
        return text + "\n\n" + INSTRUCTIONS
    return text

def description(args):
    brief = args.get("brief")
    if brief is not None:
        if not isinstance(brief, dict):
            raise ValueError("brief должен содержать work, result, acceptance, boundaries")
        parts = []
        for key, title in CONTRACT["sections"].items():
            value = brief.get(key)
            if not isinstance(value, str) or not value.strip():
                raise ValueError("Заполни brief." + key + ": " + title)
            parts.append("## " + title + "\n\n" + value.strip())
        return "\n\n".join(parts)
    raw = args.get("description")
    if not isinstance(raw, str):
        raise ValueError("Передай brief (work, result, acceptance, boundaries) либо description с четырьмя разделами.\n" + INSTRUCTIONS)
    headers = list(re.finditer(r"^##[ \t]+(.+?)[ \t]*$", raw, re.M))
    required = list(CONTRACT["sections"].values())
    selected = [h for h in headers if h.group(1) in required]
    if [h.group(1) for h in selected] != required:
        raise ValueError("Описание должно содержать разделы в порядке: " + ", ".join(required) + ".\n" + INSTRUCTIONS)
    for h in selected:
        end = next((x.start() for x in headers if x.start() > h.start()), len(raw))
        if not raw[h.end():end].strip():
            raise ValueError("Пустой раздел: " + h.group(1))
    return raw.strip()
