import re

with open('server/scripts/trigger.py', 'r', encoding='utf-8') as f:
    content = f.read()

target = """    "6848a89b-04fe-4015-bb1c-61b03782c378": {
        "name": "Оркестратор-Claude",
        "token_env": "TASKFLOW_ORCHESTRATOR_CLAUDE_TOKEN",
        "cmd": [
            CLAUDE_BIN,
            "--permission-mode", "bypassPermissions",
            # ⚠️ 26.08.2026, живьём поймано ДВА слоя одной проблемы:
            # (1) обычная переменная окружения на Popen НЕ доезжает до
            # MCP-подпроцесса, который Claude CLI поднимает сам из
            # ~/.claude.json → mcpServers.taskflow (глобальный, общий на
            # все claude на машине, env: {} пусто) — нужен СВОЙ
            # --mcp-config именно под эту учётку.
            # (2) mcp_server.py→load_token() сначала смотрит TASKFLOW_TOKEN
            # в окружении — а эта служба (taskflow-trigger.service) уже
            # запущена через vault-run.py с --secret TASKFLOW_TOKEN=***
            # (это токен Claude_Bot!), эта переменная наследуется вниз
            # через claude → MCP-подпроцесс и ПОБЕЖДАЕТ раньше, чем код
            # доходит до TASKFLOW_VAULT_KEY. Один только --mcp-config с
            # TASKFLOW_VAULT_KEY не помогает — родительский TASKFLOW_TOKEN
            # всё равно протекает вниз по цепочке.
            # Итог без обоих фиксов: Оркестратор-Claude физически работает
            # под учёткой Claude_Bot — claim/heartbeat видны верно на доске
            # (те идут через API этим скриптом), а комментарии/подзадачи
            # изнутри сессии — от чужого имени. Владелец поймал это дважды
            # подряд по расхождению «в ленте опять Claude_Bot».
            # claude-mcp-config.json ниже перебивает ОБЕ переменные:
            # TASKFLOW_TOKEN="" (гасит родительский) +
            # TASKFLOW_VAULT_KEY=правильный ключ (для чтения из vault).
            # Проверено вручную с TASKFLOW_TOKEN уже выставленным в
            # родительском shell, как это делает сама служба — сработало.
            "--mcp-config", str(HOME / ".hermes/profiles/orchestrator/claude-mcp-config.json"),
            "--strict-mcp-config",
            "-p",
        ],
        "model_flag": "--model",
        # См. комментарий на Оркестратор-Hermes выше — та же роль, тот же
        # переключатель промпта.
        "role": "orchestrator",
        # Он запускается тем же Claude CLI, что и Claude_Bot, значит умеет
        # возвращаться в свою прошлую сессию по задаче (--resume/--fork).
        # Флагом, а не догадкой по cmd[0]: у Гермеса и dsh продолжаемой
        # сессии нет вовсе, и подсунуть им эти аргументы — уронить заход.
        "claude_cli": True,
        # Имя записи в хранилище, которым его сессия ходит в TaskFlow. То же
        # самое, что в его --mcp-config: одна переменная задаёт учётку и
        # MCP-серверу, и хукам, которые claude поднимает сам.
        "vault_key": "TASKFLOW_ORCHESTRATOR_CLAUDE_TOKEN",
    },"""

replacement = """    "6848a89b-04fe-4015-bb1c-61b03782c378": {
        "name": "Оркестратор-Claude",
        "token_env": "TASKFLOW_ORCHESTRATOR_CLAUDE_TOKEN",
        "cmd": None,          # соберётся при старте, см. find_dsh()
        "env": {"PATH": "/home/maksim/.nvm/versions/node/v22.23.1/bin:"
                        + os.environ.get("PATH", "")},
        "role": "orchestrator",
        "vault_key": "TASKFLOW_ORCHESTRATOR_CLAUDE_TOKEN",
        "claude_cli": False,
    },"""

if target in content:
    content = content.replace(target, replacement)
    with open('server/scripts/trigger.py', 'w', encoding='utf-8') as f:
        f.write(content)
    print("Patched successfully!")
else:
    print("Target not found! Check line endings or text.")
