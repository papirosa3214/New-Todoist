#!/usr/bin/env python3
"""JSON-мост между in-process runtime и единственным TaskContext v1."""

import json
import sys

from task_context import (
    _load_projects_config,
    build_context,
    context_summary_ru,
    serialize_context,
)


def main() -> int:
    payload = json.load(sys.stdin)
    task = payload.get("task")
    actor = payload.get("actor")
    if not isinstance(task, dict) or not isinstance(actor, dict):
        raise ValueError("ожидаются объекты task и actor")
    context = build_context(
        task,
        actor,
        _load_projects_config(),
        mode="direct",
        parent_task_id=None,
        dependency_context=payload.get("dependency_context"),
        collaboration_context=payload.get("collaboration_context"),
    )
    print(json.dumps({
        "prompt": serialize_context(context),
        "summary": context_summary_ru(context),
        "knowledge_status": context.knowledge.get("status"),
        "dependency_status": context.dependency_context.get("status"),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
