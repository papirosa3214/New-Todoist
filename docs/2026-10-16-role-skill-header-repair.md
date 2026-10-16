# Исправление шапок навыков ролей — 16.10.2026

Исправлены девять SKILL.md: у семи отсутствовало description, у двух была синтаксически сломана YAML-шапка. Добавлены русские описания по SKILL-FORMAT.md: назначение, когда применять и когда не применять. Существующие дополнительные поля шапок сохранены.

Все девять тел после шапки побайтово совпадают с исходными, проверено SHA256 и прямым сравнением bytes. Для навыков без шапки весь исходный файл сохранён как тело.

| Навык | SHA256 неизменного тела |
| --- | --- |
| /home/maksim/taskflow/roles/architect/skills/branch-plan-pulse/SKILL.md | 4f27ed9326738e36c5a6b7d7e9698560d85a73f18e1a6633b0ac3a4e4d975d52 |
| /home/maksim/taskflow/roles/builder/skills/chat-message-queue/SKILL.md | 927447fa83735723c4a31c25eda4f2db5507208485d3acdb21aef2a4d07d236a |
| /home/maksim/taskflow/roles/builder/skills/task-archive-purge-defect/SKILL.md | 040611d3bacdbf97b4a208c49354e369748a986288a39cca5bb9ab7687742c02 |
| /home/maksim/taskflow/roles/builder/skills/taskflow-escalation-patterns/SKILL.md | 793ba891f14539ce05fcfc7798031f2781062993a96ebc589e0689de990dd4e9 |
| /home/maksim/taskflow/roles/code_orchestrator/skills/orchestrate-step-submission/SKILL.md | db79f07276df2fa7347d430cd7142f1dda79692e7f825317e842b9bab6b0c22c |
| /home/maksim/taskflow/roles/critic_verifier/skills/verdict-requires-live-scenario/SKILL.md | ff12395742a3e71d30154c42bd94396a29b727fe218d942c1b3454703fb917b5 |
| /home/maksim/taskflow/roles/researcher/skills/find-skills/SKILL.md | 2047b21b00c2f1d39073bf799381315e3240558e5b1c395f741669f3e01576ae |
| /home/maksim/taskflow/roles/secretary/skills/widget-recipes/SKILL.md | e2b42f1502f14651875ed2278818e399bdc64efd69936c0c4b175f542826fab4 |
| /home/maksim/taskflow/roles/secretary/skills/widget-renderer/SKILL.md | 78922fda64c9b3f53af180c990654f588f69112d6340248cf0318b5619445d54 |

Полный обход настоящим SDK loadSkills: 92 навыка, 10 ролей, 0 диагностик. Node 22.23.1; @earendil-works/pi-coding-agent 0.84.4. Все девять ранее пропускавшихся навыков обнаружены в наборах своих ролей. Реальное выполнение задач и семантический выбор JEV не запускались. Настройки JEV и тела навыков не менялись.

Резервные исходники и checks.json: /home/maksim/taskflow/skill-header-backup-20261016/.
