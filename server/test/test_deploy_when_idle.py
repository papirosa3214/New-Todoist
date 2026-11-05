import importlib.util
import os
import sqlite3
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "deploy-when-idle.py"
SPEC = importlib.util.spec_from_file_location("deploy_when_idle", SCRIPT)
DEPLOY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DEPLOY)


class PendingChatDeliveriesTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        # Схема повторяет боевую: очередь фильтруется по updated_at (срок
        # жизни доставки и аренда хода). Раньше здесь было только `status` —
        # тест падал с «no such column: updated_at» (29.10.2026).
        self.db.execute(
            "CREATE TABLE chat_message_queue (status TEXT NOT NULL, updated_at TEXT)"
        )

    def tearDown(self):
        self.db.close()

    def _row(self, status, updated_at):
        self.db.execute(
            "INSERT INTO chat_message_queue(status, updated_at) VALUES (?, ?)",
            (status, updated_at),
        )

    def test_superseded_and_completed_rows_do_not_block_deploy(self):
        self._row("done", "2026-10-28 00:00:00")
        self._row("failed", "2026-10-28 00:00:00")
        self._row("superseded", "2026-10-28 00:00:00")
        self.assertEqual(DEPLOY.pending_chat_deliveries(self.db), 0)

    def test_pending_and_picked_rows_block_deploy(self):
        self._row("pending", "2026-10-28 00:00:00")
        self._row("picked", "2026-10-28 00:00:00")
        self._row("superseded", "2026-10-28 00:00:00")
        self.assertEqual(DEPLOY.pending_chat_deliveries(self.db), 2)

    def test_stale_pending_row_does_not_block_deploy(self):
        # Срок жизни доставки (CHAT_DELIVERY_TTL_MIN) истёк — такая строка
        # не должна держать выкладку вечно (карточка 568a2b93).
        self._row("pending", "2020-01-01 00:00:00")
        self.assertEqual(DEPLOY.pending_chat_deliveries(self.db), 0)

    def test_stale_picked_row_does_not_block_deploy(self):
        # Аренда хода истекла — воркер, взявший доставку, умер.
        self._row("picked", "2020-01-01 00:00:00")
        self.assertEqual(DEPLOY.pending_chat_deliveries(self.db), 0)


class _Result:
    def __init__(self, returncode=0, stdout="", stderr=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


class SyncFromGithubTests(unittest.TestCase):
    """Синхронизация main с GitHub (источник правды, AGENTS.md 05.10.2026).

    Сторож не имеет права терять чужую работу: обновляться можно только
    fast-forward'ом и только на чистом дереве. Каждый отказ — это «работаем
    с локальным HEAD, как раньше», а не ошибка выкладки.
    """

    def setUp(self):
        self.calls = []
        self.original_sh = DEPLOY.sh
        self.original_log = DEPLOY.log
        self.logs = []
        # Подмена через setattr: модуль загружен через importlib, и прямая
        # присваивалась бы атрибуту, которого в типе модуля нет (Pyright).
        setattr(DEPLOY, "log", lambda msg: self.logs.append(msg))
        self.answers = {}

    def tearDown(self):
        setattr(DEPLOY, "sh", self.original_sh)
        setattr(DEPLOY, "log", self.original_log)

    def _fake_sh(self, *cmd, **kwargs):
        self.calls.append(cmd)
        key = " ".join(cmd[:3])
        for pattern, result in self.answers.items():
            if key.startswith(pattern):
                return result
        return _Result()

    def _run(self):
        setattr(DEPLOY, "sh", self._fake_sh)
        DEPLOY.sync_from_github()

    def test_fast_forward_when_remote_is_ahead(self):
        self.answers = {
            "git rev-parse HEAD": _Result(stdout="aaaa111\n"),
            "git rev-parse github/main": _Result(stdout="bbbb222\n"),
            "git merge-base --is-ancestor": _Result(returncode=1),
            "git status --porcelain": _Result(stdout=""),
            "git merge --ff-only": _Result(),
        }
        self._run()
        merges = [c for c in self.calls if c[:3] == ("git", "merge", "--ff-only")]
        self.assertEqual(len(merges), 1)
        self.assertEqual(merges[0][3], "github/main")

    def test_no_merge_when_local_is_ahead_of_remote(self):
        # Локальный main впереди: обновлять нечего, и merge недопустим.
        self.answers = {
            "git rev-parse HEAD": _Result(stdout="aaaa111\n"),
            "git rev-parse github/main": _Result(stdout="bbbb222\n"),
            "git merge-base --is-ancestor": _Result(returncode=0),
            "git status --porcelain": _Result(stdout=""),
        }
        self._run()
        self.assertEqual([c for c in self.calls if c[:3] == ("git", "merge", "--ff-only")], [])

    def test_no_merge_when_working_tree_is_dirty(self):
        # Грязное дерево: чужая несохранённая работа — не трогаем.
        self.answers = {
            "git rev-parse HEAD": _Result(stdout="aaaa111\n"),
            "git rev-parse github/main": _Result(stdout="bbbb222\n"),
            "git merge-base --is-ancestor": _Result(returncode=1),
            "git status --porcelain": _Result(stdout=" M server/src/index.ts\n"),
        }
        self._run()
        self.assertEqual([c for c in self.calls if c[:3] == ("git", "merge", "--ff-only")], [])

    def test_nothing_happens_when_already_in_sync(self):
        self.answers = {
            "git rev-parse HEAD": _Result(stdout="aaaa111\n"),
            "git rev-parse github/main": _Result(stdout="aaaa111\n"),
        }
        self._run()
        self.assertEqual([c for c in self.calls if c[:3] == ("git", "merge", "--ff-only")], [])

    def test_fetch_failure_does_not_raise(self):
        # Сеть недоступна — выкладка должна работать с локальным HEAD.
        self.answers = {
            "git fetch --quiet": _Result(returncode=128, stderr="could not resolve host\n"),
        }
        self._run()  # не должно бросить исключение
        self.assertEqual([c for c in self.calls if c[:3] == ("git", "merge", "--ff-only")], [])

    def test_non_fast_forward_merge_does_not_raise(self):
        # Расхождение веток: merge --ff-only обязан отказать, а не слить.
        self.answers = {
            "git rev-parse HEAD": _Result(stdout="aaaa111\n"),
            "git rev-parse github/main": _Result(stdout="bbbb222\n"),
            "git merge-base --is-ancestor": _Result(returncode=1),
            "git status --porcelain": _Result(stdout=""),
            "git merge --ff-only": _Result(returncode=1, stderr="Not possible to fast-forward\n"),
        }
        self._run()  # не должно бросить исключение
        self.assertEqual(len([c for c in self.calls if c[:3] == ("git", "merge", "--ff-only")]), 1)


class RuntimeWrittenRoutingTests(unittest.TestCase):
    """Смена модели в приложении пишет role-routing.yaml и не держит выкладку."""

    ROUTING = "server/scripts/role-routing.yaml"

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.bare = root / "github.git"
        self.repo = root / "repo"
        self.state = root / "state"
        self.state.mkdir()
        self._git(root, "init", "-q", "--bare", "-b", "main", str(self.bare))
        self._git(root, "clone", "-q", str(self.bare), str(self.repo))
        self._git(self.repo, "checkout", "-q", "-B", "main")
        self._git(self.repo, "remote", "rename", "origin", "github")
        self._write(self.ROUTING, "models: old\n")
        self._write("server/src/index.ts", "one\n")
        self._write("vite.config.ts", "one\n")
        self._commit("start")
        self._git(self.repo, "push", "-q", "github", "main")

        self.logs = []
        self.originals = {k: getattr(DEPLOY, k) for k in ("sh", "log", "STATE", "busy")}
        repo = self.repo
        def sh(*cmd, cwd=None, timeout=600):
            return subprocess.run(cmd, cwd=repo, capture_output=True, text=True, timeout=timeout)
        setattr(DEPLOY, "sh", sh)
        setattr(DEPLOY, "log", self.logs.append)
        setattr(DEPLOY, "STATE", str(self.state))

    def tearDown(self):
        for key, value in self.originals.items():
            setattr(DEPLOY, key, value)
        self.tmp.cleanup()

    def _git(self, cwd, *args):
        env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t", GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t")
        return subprocess.run(("git",) + args, cwd=cwd, env=env, check=True, capture_output=True, text=True).stdout.strip()

    def _write(self, rel, text, base=None):
        path = (base or self.repo) / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def _commit(self, message, base=None):
        self._git(base or self.repo, "add", "-A")
        self._git(base or self.repo, "commit", "-q", "-m", message)

    def _advance_github(self, rel):
        other = Path(self.tmp.name) / "other"
        self._git(Path(self.tmp.name), "clone", "-q", "-b", "main", str(self.bare), str(other))
        self._write(rel, "from github\n", other)
        self._commit("upstream", other)
        self._git(other, "push", "-q", "origin", "main")

    def _head(self):
        return self._git(self.repo, "rev-parse", "HEAD")

    def test_sync_fast_forwards_and_keeps_model_change(self):
        self._write(self.ROUTING, "models: new\n")
        self._advance_github("server/src/index.ts")
        DEPLOY.sync_from_github()
        self.assertEqual(self._head(), self._git(self.repo, "rev-parse", "github/main"))
        self.assertEqual((self.repo / self.ROUTING).read_text(), "models: new\n")

    def test_sync_still_waits_for_other_dirty_files(self):
        self._write(self.ROUTING, "models: new\n")
        self._write("vite.config.ts", "local\n")
        before = self._head()
        self._advance_github("server/src/index.ts")
        DEPLOY.sync_from_github()
        self.assertEqual(self._head(), before)

    def test_sync_never_overwrites_model_change_when_github_changed_it(self):
        self._write(self.ROUTING, "models: new\n")
        before = self._head()
        self._advance_github(self.ROUTING)
        DEPLOY.sync_from_github()
        self.assertEqual(self._head(), before)
        self.assertEqual((self.repo / self.ROUTING).read_text(), "models: new\n")

    def _run_main_with_pending_server_commit(self):
        (self.state / "deployed").write_text(self._head())
        self._write("server/src/index.ts", "two\n")
        self._git(self.repo, "add", "server/src/index.ts")
        self._git(self.repo, "commit", "-q", "-m", "server change")
        self._git(self.repo, "push", "-q", "github", "main")
        setattr(DEPLOY, "busy", lambda: (1, 0))
        DEPLOY.main()

    def test_main_is_not_held_by_model_change(self):
        self._write(self.ROUTING, "models: new\n")
        self._run_main_with_pending_server_commit()
        self.assertFalse([m for m in self.logs if "незакоммиченные" in m], self.logs)
        self.assertTrue([m for m in self.logs if "занято" in m], self.logs)

    def test_main_still_waits_for_other_server_changes(self):
        self._write(self.ROUTING, "models: new\n")
        self._run_main_with_pending_server_commit()
        self.logs.clear()
        self._write("server/src/other.ts", "wip\n")
        DEPLOY.main()
        self.assertTrue([m for m in self.logs if "незакоммиченные" in m], self.logs)


if __name__ == "__main__":
    unittest.main()
