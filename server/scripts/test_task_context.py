# Тесты для server/scripts/task_context.py
# Шаг 6 архивного ТЗ docs/archive/2026-09-24-before-canonical/taskflow-direct-dispatch-mvp.md.
# Прогон: python3 server/scripts/test_task_context.py
# (не требует pytest — просто стандартный unittest из stdlib.)

import json
import sys
import unittest

sys.path.insert(0, "/home/maksim/Проекты/New-Todoist/server/scripts")

import task_context as tc  # noqa: E402


class TestTaskContextSchema(unittest.TestCase):
    """Шаг 2 ТЗ: схема TaskContext жёсткая и предсказуемая."""

    def test_direct_mode(self):
        """Прямой исполнитель: mode='direct', parent_task_id=None."""
        ctx = tc.build_context(
            {"id": "t1", "title": "прямая", "description": "d"},
            {"id": "u2", "name": "Claude_Bot"},
        )
        self.assertEqual(ctx.schema_version, "task-context/v1")
        self.assertEqual(ctx.assignment["mode"], "direct")
        self.assertIsNone(ctx.assignment["parent_task_id"])
        self.assertEqual(ctx.assignment["actor_id"], "u2")
        self.assertEqual(ctx.assignment["actor_name"], "Claude_Bot")

    def test_coordinated_mode(self):
        """Оркестратор: mode='coordinated', parent_task_id=корень."""
        ctx = tc.build_context(
            {"id": "t9", "title": "составная", "description": "root"},
            {"id": "u9", "name": "Orchestrator"},
            mode="coordinated",
            parent_task_id="root-1",
        )
        self.assertEqual(ctx.assignment["mode"], "coordinated")
        self.assertEqual(ctx.assignment["parent_task_id"], "root-1")
        self.assertEqual(ctx.assignment["actor_id"], "u9")

    def test_required_task_fields(self):
        """TaskEnricher обязателен — без id/title бросает."""
        with self.assertRaises(tc.EnrichmentError):
            tc.build_context({}, {"id": "u2"})
        with self.assertRaises(tc.EnrichmentError):
            tc.build_context({"id": "x"}, {"id": "u2"})

    def test_truncate(self):
        """MAX_EXCERPT_CHARS — жёсткая обрезка строки."""
        s = "x" * 1000
        out = tc.truncate(s, limit=100)
        self.assertEqual(len(out), 100)
        out_default = tc.truncate(s)
        self.assertLessEqual(len(out_default), tc.MAX_EXCERPT_CHARS)

    def test_dependency_context_is_serialized(self):
        ctx = tc.build_context(
            {"id": "t1", "title": "интеграция"},
            {"id": "u2", "name": "Builder"},
            dependency_context={
                "status": "ok", "version": 1,
                "root": {"task_id": "root", "title": "Родитель", "goal": "Собрать итог", "recent_comments": ["Контракт принят"]},
                "dependencies": [{"task_id": "a", "title": "Исследование", "status": "active", "agent_state": "review", "result": "Источники проверены", "artifact_refs": ["docs/research.md"]}],
                "open_questions": [],
            },
        )
        text = tc.serialize_context(ctx)
        self.assertIn("dependency_context: status=ok", text)
        self.assertIn("root: root Родитель", text)
        self.assertIn("result: Источники проверены", text)
        self.assertIn("Связанные результаты: 1 предшественник", tc.context_summary_ru(ctx))

    def test_collaboration_context_is_serialized(self):
        """T03: collaboration_context — отдельный блок, не смешанный с dependency_context."""
        ctx = tc.build_context(
            {"id": "t1", "title": "продуктовая фича"},
            {"id": "u2", "name": "Builder"},
            dependency_context={"status": "empty", "version": 1, "root": None, "dependencies": [], "open_questions": []},
            collaboration_context={
                "status": "ok", "plan_id": "tcp_1", "revision": 1, "slot_key": "delivery",
                "predecessor_artifacts": [
                    {"slot_key": "analysis", "artifact_key": "feature_spec", "summary": "Согласован scope",
                     "payload": {"scope": "в рамках"}, "evidence": [{"path": "docs/spec.json"}]},
                ],
            },
        )
        text = tc.serialize_context(ctx)
        self.assertIn("collaboration_context: status=ok, plan=tcp_1, revision=1, slot=delivery, predecessor_artifacts=1", text)
        self.assertIn("predecessor: analysis -> feature_spec", text)
        self.assertIn("summary: Согласован scope", text)
        self.assertIn("scope: в рамках", text)
        self.assertIn("evidence: docs/spec.json", text)
        # dependency_context пуст, значит его блок в тексте не появляется, но collaboration_context — независимо от него.
        self.assertNotIn("dependency_context: status=ok", text)


class TestEnrichersSoft(unittest.TestCase):
    """Шаг 3 ТЗ: падение необязательного адаптера — status=unavailable,
    а не exception наружу."""

    def test_knowledge_unavailable_when_no_kb(self):
        """Нет ~/kb/kb_query.py → status='unavailable', НЕ exception."""
        # kb_query.py на этой машине точно нет — обогатитель должен
        # тихо вернуть 'unavailable', build_context не должен падать.
        ctx = tc.build_context(
            {"id": "t1", "title": "тест", "description": "d"},
            {"id": "u2", "name": "Bot"},
        )
        self.assertIn(
            ctx.knowledge["status"], ("ok", "empty", "unavailable")
        )

    def test_knowledge_parses_real_kb_contract(self):
        """Фактический ответ kb_query.py --json разбирается в фрагменты.

        Раньше код читал ключ 'excerpts', которого база не отдаёт, и блок
        уходил в 'unavailable' на каждом запуске — то есть исполнитель
        никогда не видел базу знаний. Тест держит именно контракт:
        {'results': [{source, score, text, date, verified}]}.
        """
        ответ_базы = json.dumps({
            "results": [{
                "source": "2026-08-29-пример-урока.md",
                "score": 0.56,
                "text": "тело урока",
                "date": "2026-08-29",
                "verified": "2026-09-01",
            }],
            "context": "…",
        })
        оригинал = tc._run_external
        tc._run_external = lambda cmd, stdin=None, timeout_sec=None: (0, ответ_базы, "")
        try:
            status, excerpts = tc._knowledge_from_kb("запрос")
        finally:
            tc._run_external = оригинал

        self.assertEqual(status, "ok")
        self.assertEqual(len(excerpts), 1)
        фрагмент = excerpts[0]
        self.assertEqual(фрагмент["excerpt"], "тело урока")
        self.assertEqual(фрагмент["title"], "2026-08-29-пример-урока.md")
        # Дата последней проверки важнее даты написания.
        self.assertEqual(фрагмент["date"], "2026-09-01")
        # Поля происхождения (раздел 8.5 спецификации) обязаны быть.
        self.assertEqual(фрагмент["knowledge_type"], "changeable")
        self.assertTrue(фрагмент["origin"])
        self.assertIn("--get", фрагмент["reference"])

    def test_kb_keeps_one_excerpt_per_lesson(self):
        """Куски одного урока не занимают весь лимит.

        Поиск отдаёт фрагменты, и один урок легко идёт несколько раз
        подряд. Для исполнителя это один источник: если не свернуть, два
        урока съедают все слоты и остальное не доезжает.
        """
        ответ_базы = json.dumps({
            "results": [
                {"source": "урок-А.md", "text": "кусок 1", "date": "2026-09-01"},
                {"source": "урок-А.md", "text": "кусок 2", "date": "2026-09-01"},
                {"source": "урок-Б.md", "text": "другой", "date": "2026-09-02"},
            ],
        })
        оригинал = tc._run_external
        tc._run_external = lambda cmd, stdin=None, timeout_sec=None: (0, ответ_базы, "")
        try:
            _, excerpts = tc._knowledge_from_kb("запрос")
        finally:
            tc._run_external = оригинал

        self.assertEqual([e["title"] for e in excerpts], ["урок-А.md", "урок-Б.md"])
        # Берётся первый (лучший по релевантности) кусок урока.
        self.assertEqual(excerpts[0]["excerpt"], "кусок 1")

    def test_mnemosyne_parses_real_contract(self):
        """Ответ `mnemosyne recall --json` разбирается в фрагменты.

        До 14.09.2026 память была заявлена в комментарии обогатителя, но
        не вызывалась ни разу.
        """
        ответ_памяти = json.dumps({
            "query": "q",
            "results": [{
                "id": "f361306f103b0399",
                "content": "владелец держит обои в ~/Movies/Wallpapers",
                "source": "fact",
                "timestamp": "2026-09-14T02:20:31.062964",
                "score": 0.53,
            }],
        })
        перехват: dict = {}
        оригинал = tc._run_external

        def подмена(cmd, stdin=None, timeout_sec=None):
            перехват["cmd"] = cmd
            return (0, ответ_памяти, "")

        tc._run_external = подмена
        try:
            status, excerpts = tc._knowledge_from_mnemosyne("запрос")
        finally:
            tc._run_external = оригинал

        self.assertEqual(status, "ok")
        self.assertEqual(len(excerpts), 1)
        # --json у recall не описан в help, но поддержан. Без него CLI
        # печатает текст для человека и обрезает содержимое многоточием.
        self.assertIn("--json", перехват["cmd"])
        фрагмент = excerpts[0]
        self.assertEqual(фрагмент["source"], "mnemosyne")
        self.assertIn("обои", фрагмент["excerpt"])
        # Только дата, без времени суток.
        self.assertEqual(фрагмент["date"], "2026-09-14")
        self.assertEqual(фрагмент["knowledge_type"], "changeable")

    def test_knowledge_survives_one_dead_source(self):
        """Отказ одного источника не отменяет другой.

        Иначе временная поломка памяти лишала бы исполнителя и уроков.
        """
        ответ_базы = json.dumps({
            "results": [{"source": "урок.md", "text": "тело", "date": "2026-09-01"}],
        })
        оригинал = tc._run_external

        def подмена(cmd, stdin=None, timeout_sec=None):
            # Память недоступна, база знаний отвечает.
            if cmd and cmd[0] == "mnemosyne":
                return (127, "", "not_found")
            return (0, ответ_базы, "")

        tc._run_external = подмена
        try:
            block = tc.enrich_knowledge({"title": "т", "description": "о"})
        finally:
            tc._run_external = оригинал

        self.assertEqual(block["status"], "ok")
        self.assertEqual(len(block["excerpts"]), 1)
        self.assertEqual(block["excerpts"][0]["source"], "kb")

    def test_knowledge_unavailable_only_when_both_sources_dead(self):
        """«Недоступно» — только когда молчат оба источника."""
        оригинал = tc._run_external
        tc._run_external = lambda cmd, stdin=None, timeout_sec=None: (127, "", "нет")
        try:
            block = tc.enrich_knowledge({"title": "т", "description": "о"})
        finally:
            tc._run_external = оригинал
        self.assertEqual(block["status"], "unavailable")

    def test_both_sources_get_their_share(self):
        """Память не вытесняется базой знаний.

        Без квоты база забирает весь лимит первой, и записи памяти не
        доходят до исполнителя вообще.
        """
        ответ_базы = json.dumps({
            "results": [
                {"source": f"урок-{i}.md", "text": f"тело {i}", "date": "2026-09-01"}
                for i in range(10)
            ],
        })
        ответ_памяти = json.dumps({
            "results": [
                {"id": f"m{i}", "content": f"запись {i}", "source": "fact",
                 "timestamp": "2026-09-14T00:00:00"}
                for i in range(10)
            ],
        })
        оригинал = tc._run_external

        def подмена(cmd, stdin=None, timeout_sec=None):
            if cmd and cmd[0] == "mnemosyne":
                return (0, ответ_памяти, "")
            return (0, ответ_базы, "")

        tc._run_external = подмена
        try:
            block = tc.enrich_knowledge({"title": "т", "description": "о"})
        finally:
            tc._run_external = оригинал

        источники = {e["source"] for e in block["excerpts"]}
        self.assertEqual(источники, {"kb", "mnemosyne"})
        self.assertLessEqual(len(block["excerpts"]), tc.MAX_KNOWLEDGE_EXCERPTS)

    def test_knowledge_requests_json_output(self):
        """Вызов базы знаний идёт с --json.

        Без флага kb_query.py печатает текст для человека, json.loads на
        нём падает, и блок снова станет мёртвым — молча.
        """
        перехват: dict = {}
        оригинал = tc._run_external

        def подмена(cmd, stdin=None, timeout_sec=None):
            перехват["cmd"] = cmd
            перехват["timeout"] = timeout_sec
            return (0, json.dumps({"results": []}), "")

        tc._run_external = подмена
        try:
            tc._knowledge_from_kb("запрос")
        finally:
            tc._run_external = оригинал

        self.assertIn("--json", перехват["cmd"])
        # И отдельный лимит: на холодную база грузит модель эмбеддингов и
        # в общие 3 секунды не укладывается.
        self.assertEqual(перехват["timeout"], tc.KNOWLEDGE_TIMEOUT_SEC)
        self.assertGreater(tc.KNOWLEDGE_TIMEOUT_SEC, tc.ADAPTER_TIMEOUT_SEC)

    def test_repository_empty_without_config(self):
        """Без конфига проекта → status='empty'."""
        ctx = tc.build_context(
            {"id": "t1", "title": "тест", "description": "d"},
            {"id": "u2", "name": "Bot"},
            projects_config=None,
        )
        self.assertEqual(ctx.repository["status"], "empty")


class TestCommentsLimit(unittest.TestCase):
    """MAX_COMMENTS — не более 5 в conversation.latest_comments."""

    def test_comments_truncated_to_max(self):
        comments = [
            {"author": f"u{i}", "text": f"msg {i}", "created_at": ""}
            for i in range(20)
        ]
        ctx = tc.build_context(
            {"id": "t1", "title": "тест", "description": "d",
             "comments": comments},
            {"id": "u2", "name": "Bot"},
        )
        self.assertLessEqual(
            len(ctx.conversation["latest_comments"]), tc.MAX_COMMENTS
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
