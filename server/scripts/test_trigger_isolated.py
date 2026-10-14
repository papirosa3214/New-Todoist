# Изолированные тесты trigger.py: реальные границы handle_task, run_external,
# get_task, контекст с мягким отказом KB/repo.
# Мокаем APIClient, threading.Thread.start, build_context.

import sys
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

sys.path.insert(0, "/home/maksim/Проекты/New-Todoist/server/scripts")

import trigger  # noqa: E402


def make_task(task_id="t1", agent_state=None, assignee_id="u2", status="active"):
    return {
        "id": task_id,
        "title": "тест",
        "description": "d",
        "status": status,
        "agent_state": agent_state,
        "parent_id": None,
        "assignee_id": assignee_id,
    }


class TestHandleTask(unittest.TestCase):

    def setUp(self):
        # RUNNING — persistent словарь с no-op pop (run_external в finally
        # делает pop — это нам мешает; нужно, чтобы task_id в RUNNING
        # сохранялся между вызовами, иначе защита `if task_id in RUNNING`
        # никогда не сработает).
        class _NoPopDict(dict):
            def pop(self, *a, **kw):  # noqa: ARG002
                return None
        self._running_storage = _NoPopDict()
        self.patches = [
            patch.object(trigger, "log"),
            patch.object(trigger, "LOCK", new=MagicMock()),
            patch.object(trigger, "RUNNING", self._running_storage),
            patch.object(trigger, "note", return_value=None),
            # threading.Thread — не запускаем реальные потоки, ловим
            # вызовы target.
            patch.object(trigger.threading, "Thread",
                         side_effect=lambda target, args=(), daemon=False:
                         SimpleNamespace(start=MagicMock(), _target=target)),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()

    def test_1_repeat_same_event_starts_process_only_once(self):
        """Повторное одинаковое событие для одной карточки → один процесс.

        Защита в run_external: `if task_id in RUNNING: return`.
        Тестируем run_external напрямую: первый вызов добавляет task_id
        в RUNNING и (в моке) записывает факт запуска; второй вызов с тем
        же task_id — return без записи.
        """
        task = make_task()
        started: list[str] = []

        def fake_start_process(*args, **kwargs):  # noqa: ARG001
            # Имитируем успешный первый запуск: записали в RUNNING,
            # запомнили факт. Возвращаем proc-мок: run_external дальше зовёт
            # communicate() и смотрит returncode.
            with trigger.LOCK:
                trigger.RUNNING[task["id"]] = (MagicMock(), "u2")
            started.append(task["id"])
            proc = MagicMock(returncode=0)
            proc.communicate.return_value = (None, None)
            return proc

        # Гейт inbox и claim идут через api — мокаем его, иначе тест ходит
        # в живой сервер. Контекст тоже мокаем: раньше тест случайно жил на
        # том, что обогатители контекста звали Popen через subprocess.run;
        # с гейтом запуск до контекста не доходит, а зависеть от этого
        # побочного эффекта неправильно.
        import task_context

        def fake_api(method, path, body=None, token="", **kw):  # noqa: ARG001
            if path == "/api/agent-inbox/pending":
                return {"items": []}
            return {}

        fake_ctx = SimpleNamespace(
            schema_version="task-context/v1",
            knowledge={"status": "ok"},
            repository={"status": "ok"},
            warnings=[],
        )
        with patch.object(trigger, "get_task", return_value=task), \
             patch.object(trigger, "log"), \
             patch.object(trigger, "api", side_effect=fake_api), \
             patch.object(task_context, "build_context", return_value=fake_ctx), \
             patch.object(trigger, "EXTERNAL_AGENTS", {
                 "u2": {"name": "Bot", "role": None, "resident": False, "token": "T"}
             }):
            # Подменяем subprocess.Popen — run_external пойдёт по защите
            # в RUNNING раньше, чем дойдёт до запуска процесса. Тестируем
            # саму защиту: первый вызов должен стартовать, второй — нет.
            with patch.object(trigger.subprocess, "Popen",
                              side_effect=fake_start_process), \
                 patch.object(trigger, "activity_mark", return_value=("", "")), \
                 patch.object(trigger, "set_state", return_value=None), \
                 patch.object(trigger, "note", return_value=None):
                # Первый запуск: идём через `if task_id in RUNNING: return` —
                # task_id в RUNNING нет, поэтому стартуем.
                trigger.RUNNING.pop("t1", None)  # чистый старт
                trigger.run_external(task, "ok", {
                    "name": "Bot", "role": None, "resident": False,
                    "token": "T", "cmd": ["/bin/true"],
                })
                # Второй запуск: task_id в RUNNING — return без нового старта.
                before = len(started)
                trigger.run_external(task, "ok", {
                    "name": "Bot", "role": None, "resident": False,
                    "token": "T", "cmd": ["/bin/true"],
                })
                after = len(started)
                self.assertEqual(before, after,
                                 f"второй запуск стартанул процесс, started={started}")
                self.assertEqual(len(started), 1,
                                 f"ожидался ровно 1 процесс, стартовало {len(started)}")

    def test_2_review_state_does_not_start_process(self):
        """Задача в `review` → decide False → Thread не создан."""
        task = make_task(agent_state="review")
        with patch.object(trigger, "get_task", return_value=task), \
             patch.object(trigger, "decide", return_value=(False, "ждёт проверки владельца")), \
             patch.object(trigger, "EXTERNAL_AGENTS", {
                 "u2": {"name": "Bot", "role": None, "resident": False, "token": "T"}
             }):
            trigger.handle_task("t1", "комментарий")
        # Thread НЕ должен быть создан.
        self.assertEqual(trigger.threading.Thread.call_count, 0)

    def test_3_get_task_none_does_not_start_process(self):
        """get_task возвращает None (карточка не читается) → Thread не создан.

        Это ОБЯЗАТЕЛЬНАЯ часть пакета (Шаг 3 ТЗ). При сбое чтения запуск
        не происходит.
        """
        with patch.object(trigger, "get_task", return_value=None):
            trigger.handle_task("missing", "event")
        self.assertEqual(trigger.threading.Thread.call_count, 0)

    def test_4_soft_kb_repo_failure_still_starts(self):
        """Мягкий отказ KB/repo → process всё равно стартует.

        build_context для задачи с реальным title/description + agent
        вернёт knowledge.status='unavailable' (kb_query.py отсутствует
        на тестовом окружении) и repository.status='empty' (нет
        project_id → нет repo_root). Это НЕ блокирует запуск.
        """
        from task_context import build_context
        task = make_task()
        with patch.object(trigger, "get_task", return_value=task), \
             patch.object(trigger, "decide", return_value=(True, "ok")), \
             patch.object(trigger, "EXTERNAL_AGENTS", {
                 "u2": {"name": "Bot", "role": None, "resident": False, "token": "T"}
             }):
            # Проверяем, что build_context для такой задачи даёт
            # unavailable/empty, а не падает.
            c = build_context(task, {"id": "u2", "name": "Bot"})
            self.assertIn(c.knowledge["status"], ("unavailable", "empty", "ok"))
            self.assertEqual(c.repository["status"], "empty")
            # Запускаем handle_task — Thread должен быть создан.
            trigger.handle_task("t1", "event")
        self.assertEqual(trigger.threading.Thread.call_count, 1)


class TestInboxGate(unittest.TestCase):
    """Единая доставка поручений (Review 07.09.2026): гейт agent_inbox ДО claim.

    run_external обязан: принять свои события (sent → received) до claim;
    устаревшее или уже разобранное событие — отменить запуск без claim;
    сбой claim — оставить видимую blocked-причину; после claim — acting;
    по итогу цепочки — done или blocked.
    """

    def setUp(self):
        self.calls: list[tuple] = []
        self.pending: list[dict] = []
        self.mark_results: list[dict] = []
        self.claim_result: object = {}
        self.pending_unavailable = False

        class _NoPopDict(dict):
            def pop(self, *a, **kw):  # noqa: ARG002
                return None
        self._running_storage = _NoPopDict()
        self.proc = MagicMock(returncode=0)
        self.proc.communicate.return_value = (None, None)
        self.proc_box: list = []

        import task_context
        self._ctx = SimpleNamespace(
            schema_version="task-context/v1",
            knowledge={"status": "ok"},
            repository={"status": "ok"},
            warnings=[],
        )

        def fake_api(method, path, body=None, token="", **kw):
            self.calls.append((method, path, body))
            if path == "/api/agent-inbox/pending":
                return None if self.pending_unavailable else {"items": self.pending}
            if path.startswith("/api/agent-inbox/") and path.endswith("/mark"):
                if self.mark_results:
                    return self.mark_results.pop(0)
                return {"id": "ev", "status": (body or {}).get("status")}
            if path.endswith("/claim"):
                return self.claim_result
            return {}

        self.patches = [
            patch.object(trigger, "log"),
            patch.object(trigger, "note", return_value=None),
            patch.object(trigger, "LOCK", new=MagicMock()),
            patch.object(trigger, "RUNNING", self._running_storage),
            patch.object(trigger, "api", side_effect=fake_api),
            patch.object(trigger, "activity_mark", return_value=("", "")),
            patch.object(trigger, "should_continue", return_value=(False, "стоп")),
            patch.object(trigger, "read_usage", return_value=""),
            patch.object(task_context, "build_context", return_value=self._ctx),
            patch.object(trigger.threading, "Thread",
                         side_effect=lambda target, args=(), daemon=False:
                         SimpleNamespace(start=MagicMock(), _target=target)),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()

    def run_ext(self, rc: int = 0):
        self.proc.returncode = rc
        task = make_task()
        trigger.RUNNING.pop(task["id"], None)

        def fake_popen(*a, **kw):  # noqa: ARG001
            self.proc_box.append(self.proc)
            return self.proc

        with patch.object(trigger.subprocess, "Popen", side_effect=fake_popen):
            trigger.run_external(task, "ok", {
                "name": "Bot", "role": None, "resident": False,
                "token": "T", "cmd": ["/bin/true"],
            })
        return task

    def marks(self):
        return [(b or {}).get("status")
                for _, path, b in self.calls
                if path.startswith("/api/agent-inbox/") and path.endswith("/mark")]

    def claims(self):
        return [(b or {}) for _, path, b in self.calls if path.endswith("/claim")]

    def test_1_stale_event_cancels_launch_before_claim(self):
        """Устаревшее событие (dropped) → запуск отменён, claim не звался."""
        self.pending = [{"id": "ev1", "task_id": "t1", "task_version": 1,
                         "event_type": "review_return"}]
        self.mark_results = [{"id": "ev1", "status": "blocked", "dropped": True}]
        self.run_ext()
        self.assertEqual(self.marks(), ["received"],
                         "попытка принять событие была, дальше — нет")
        self.assertEqual(self.claims(), [], "claim не должен зваться по устаревшему событию")
        self.assertEqual(self.proc_box, [], "процесс не должен запускаться")

    def test_2_fresh_event_claim_acting_done(self):
        """Свежее событие: received до claim → claim → acting → done."""
        self.pending = [{"id": "ev1", "task_id": "t1", "task_version": 2,
                         "event_type": "assignment"}]
        self.mark_results = [{"id": "ev1", "status": "received"}]
        self.claim_result = {}
        self.run_ext()
        self.assertEqual(self.claims(), [{}], "claim звался ровно один раз")
        self.assertEqual(self.marks(), ["received", "acting", "done"])
        self.assertEqual(len(self.proc_box), 1, "процесс запущен один раз")

    def test_3_no_events_launches_normally(self):
        """Событий по карточке нет (комментарий владельца) — старые пути живы."""
        self.pending = []
        self.claim_result = {}
        self.run_ext()
        self.assertEqual(self.claims(), [{}])
        self.assertEqual(self.marks(), [])
        self.assertEqual(len(self.proc_box), 1)

    def test_4_claim_failure_leaves_visible_blocked_reason(self):
        """Сбой запуска: claim не удался → события blocked с причиной."""
        self.pending = [{"id": "ev1", "task_id": "t1", "task_version": 2}]
        self.mark_results = [{"id": "ev1", "status": "received"}]
        self.claim_result = None
        self.run_ext()
        self.assertEqual(self.proc_box, [])
        self.assertEqual(self.marks(), ["received", "blocked"])
        # Причина blocked видима в теле вызова.
        blocked = [b for _, path, b in self.calls
                   if path.endswith("/mark") and (b or {}).get("status") == "blocked"]
        self.assertIn("claim", blocked[0].get("blocked_reason", ""))

    def test_5_pending_unavailable_cancels_launch(self):
        """Inbox недоступен → запуск отменяется (проверка доставки обязательна)."""
        self.pending_unavailable = True
        self.claim_result = {}
        self.run_ext()
        self.assertEqual(self.claims(), [], "без проверки доставки claim не делаем")
        self.assertEqual(self.proc_box, [])

    def test_6_process_failure_marks_blocked(self):
        """Процесс упал (код 3) → события blocked с кодом, а не done."""
        self.pending = [{"id": "ev1", "task_id": "t1", "task_version": 2}]
        self.mark_results = [{"id": "ev1", "status": "received"}]
        self.claim_result = {}
        self.run_ext(rc=3)
        self.assertEqual(self.marks(), ["received", "acting", "blocked"])
        blocked = [b for _, path, b in self.calls
                   if path.endswith("/mark") and (b or {}).get("status") == "blocked"]
        self.assertIn("кодом 3", blocked[0].get("blocked_reason", ""))


if __name__ == "__main__":
    unittest.main(verbosity=2)