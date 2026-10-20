# -*- coding: utf-8 -*-
"""Сама проба из kb_reachable_watch на подставной базе знаний.

Проверяет главное: «сколько всего» снимается ДВАЖДЫ — до и после обхода списка,
и база, двинувшаяся под проверкой, видна как движение, а не как поломка.

Запуск:
    AR_FILE=/tmp/infra-ops-fix/autonomy-report.py python3 test_probe_live.py
"""
import ast
import contextlib
import importlib.util
import io
import os
import sys
import types

AR_FILE = os.environ.get("AR_FILE", "/tmp/infra-ops-fix/autonomy-report.py")

src = io.open(AR_FILE, encoding="utf-8").read()
tree = ast.parse(src)
fn = [n for n in tree.body
      if isinstance(n, ast.FunctionDef) and n.name == "kb_reachable_watch"][0]
probe = next(ast.literal_eval(n.value) for n in ast.walk(fn)
             if isinstance(n, ast.Assign)
             and any(getattr(t, "id", "") == "probe" for t in n.targets))


def make_stub(total_by_ds, shrink_to=None):
    """Подставная база. shrink_to — сколько документов ОСТАЛОСЬ после обхода."""
    stub = types.ModuleType("kb_query")
    state = {"calls": 0}

    stub._cfg = lambda: {"dataset_ids": list(total_by_ds)}

    def _ragflow_json(cfg, path, **kw):
        ds = path.split("/datasets/")[1].split("/")[0]
        state["calls"] += 1
        # первый замер каждого датасета — до обхода, второй — после
        if state["calls"] > len(total_by_ds) and shrink_to is not None:
            return {"data": {"total": shrink_to[ds], "docs": []}}
        return {"data": {"total": total_by_ds[ds], "docs": []}}

    stub._ragflow_json = _ragflow_json
    # список отдаёт документы, какие видел В МОМЕНТ обхода — до того как база двинулась
    stub.list_documents = lambda: [
        {"dataset_id": ds, "id": "d%d" % i, "name": "n%d" % i}
        for ds, n in total_by_ds.items()
        for i in range(n)
    ]
    stub.get_document_text = lambda ds, i: "текст урока " * 20
    return stub


def run(stub):
    sys.modules["kb_query"] = stub
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        exec(compile(probe, "<probe>", "exec"), {"__name__": "__probe__"})
    return dict(l.split("=", 1) for l in buf.getvalue().strip().splitlines())


D = {"a": 954, "b": 500, "c": 85}

if __name__ == "__main__":
    print("Покой (база не меняется):     ", run(make_stub(D)))
    print("База сжалась под проверкой:   ", run(make_stub(D, shrink_to={"a": 953, "b": 500, "c": 85})))
    print("База выросла под проверкой:   ", run(make_stub(D, shrink_to={"a": 955, "b": 500, "c": 85})))
