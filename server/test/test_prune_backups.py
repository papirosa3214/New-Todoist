import importlib.util
import os
import shutil
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "deploy-when-idle.py"
SPEC = importlib.util.spec_from_file_location("deploy_when_idle", SCRIPT)
DEPLOY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DEPLOY)


class PruneBackupsTests(unittest.TestCase):
    """Ротация склада копий БД.

    Склад рос без удержания: 179 файлов pre-deploy-*.db на 22 ГБ. Функция
    обязана удалять ТОЛЬКО копии, которые снимает сам скрипт выкладки, и
    оставлять ручные — под конкретный разбор они могут быть единственными.
    """

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="taskflow-backups-")
        # Функция ищет копии в <SERVER>/backups — подменяем SERVER на
        # временную папку, а файлы кладём в её подкаталог backups.
        self.backups = os.path.join(self.dir, "backups")
        os.makedirs(self.backups, exist_ok=True)
        self.original_server = DEPLOY.SERVER
        setattr(DEPLOY, "SERVER", self.dir)
        self.logs = []
        setattr(DEPLOY, "log", lambda msg: self.logs.append(msg))

    def tearDown(self):
        setattr(DEPLOY, "SERVER", self.original_server)
        shutil.rmtree(self.dir, ignore_errors=True)

    def _make(self, name, size=10):
        path = os.path.join(self.backups, name)
        with open(path, "wb") as f:
            f.write(b"x" * size)
        return path

    def test_keeps_only_newest_pre_deploy_copies(self):
        for i in range(20):
            self._make(f"pre-deploy-202610{i:02d}-1200.db")
        DEPLOY.prune_backups(keep=10)
        left = sorted(n for n in os.listdir(self.backups) if n.startswith("pre-deploy-"))
        self.assertEqual(len(left), 10)
        # Остались самые свежие (по метке времени в имени).
        self.assertEqual(left[-1], "pre-deploy-20261019-1200.db")
        self.assertEqual(left[0], "pre-deploy-20261010-1200.db")

    def test_manual_backups_are_never_removed(self):
        manual = [
            "rescue-20261007-wiped-current.db",
            "mak112-20261009-080820.db",
            "durable-review-20261011.db",
            "taskflow-before-dupe-purge-20261008.db",
            # Названная похоже на автобэкап, но ручная — под шаблон не подходит.
            "pre-deploy-manual-20261026-1952.db",
        ]
        for name in manual:
            self._make(name)
        for i in range(20):
            self._make(f"pre-deploy-202610{i:02d}-1200.db")
        DEPLOY.prune_backups(keep=10)
        for name in manual:
            self.assertTrue(
                os.path.exists(os.path.join(self.backups, name)),
                f"ручная копия {name} не должна удаляться",
            )

    def test_nothing_removed_when_below_limit(self):
        for i in range(5):
            self._make(f"pre-deploy-202610{i:02d}-1200.db")
        DEPLOY.prune_backups(keep=10)
        self.assertEqual(len(os.listdir(self.backups)), 5)

    def test_missing_directory_is_not_an_error(self):
        setattr(DEPLOY, "SERVER", os.path.join(self.dir, "нет-такого"))
        DEPLOY.prune_backups(keep=10)  # не должно бросить

    def test_other_files_in_folder_survive(self):
        marker = self._make("README.txt")
        for i in range(20):
            self._make(f"pre-deploy-202610{i:02d}-1200.db")
        DEPLOY.prune_backups(keep=10)
        self.assertTrue(os.path.exists(marker))


if __name__ == "__main__":
    unittest.main()
