#!/usr/bin/env python3
"""Будильник TaskFlow: доска может позвать Pi Agent в работу.

Тот же смысл, что у kaneo-trigger, но без вебхуков — TaskFlow уже отдаёт
живой поток событий по WebSocket, а уведомления вдобавок хранятся в базе.
Это надёжнее вебхука: пока служба лежала, события не потерялись — при старте
она добирает непрочитанные уведомления и разбирает их.

Что делает:
  1. Держит WebSocket агентским токеном. Пока сокет открыт, Pi Agent показан
     «онлайн» на экране агентов (server/src/ws.ts) — отдельного пинга не надо.
  2. Ловит notification:new (назначение задачи, комментарий).
  3. Решает, повод ли это (см. decide) и запускает Pi по задаче.
  4. Пока Pi работает, задача живёт по AGENT-PROTOCOL.md: claim →
     heartbeat → review. Аренду продлевает эта же служба, чтобы работа не
     помечалась брошенной, пока процесс жив.

Токен приходит в окружении (TASKFLOW_TOKEN) — служба запускается через
vault-run.py, значение нигде не печатается и на диске не лежит.
"""
import hashlib
import hmac
import json
import os
import re
import subprocess
import sys
import threading
import time
import uuid
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

import websocket  # websocket-client

API = os.environ.get("TASKFLOW_API", "http://localhost:3001")
WS_URL = API.replace("http://", "ws://").replace("https://", "wss://") + "/ws"
TOKEN = os.environ.get("TASKFLOW_TOKEN", "").strip()
# Токен Гермеса — вторым соединением. Уведомления сервер шлёт ТОЛЬКО
# адресату, поэтому служба, слушающая под учёткой Claude_Bot, про
# назначение задачи Гермесу не узнаёт вовсе: 21.08.2026 владелец назначил
# карточку и ничего не произошло — «не берёт в работу, будильник не зовёт».
# Одно соединение на агента, чьи задачи мы обслуживаем.
HERMES_TOKEN = os.environ.get("TASKFLOW_HERMES_TOKEN", "").strip()
HOME = Path.home()
CLAUDE_BIN = str(HOME / ".npm-global/bin/claude")
PI_AGENT_ID = "1fa09a0a-0c41-4e7e-982a-a1c46570e5d2"
PI_BIN = str(HOME / ".local/bin/pi")
STATE_DIR = HOME / ".local/state/taskflow-trigger"
ALIVE_FILE = STATE_DIR / "alive"
ALIVE_BEAT_SEC = 30
LOG_FILE = STATE_DIR / "trigger.log"

ME = PI_AGENT_ID

# Учётки, чьи комментарии в карточке пишет САМА служба, а не исполнитель:
# по ним нельзя судить, было ли движение в заходе (см. activity_mark).
SERVICE_AUTHORS = {ME}

ROLE_NAMES = frozenset({
    "researcher",
    "analyst",
    "synthesizer",
    "critic_verifier",
    "architect",
    "builder",
    "qa",
    "designer",
})
ROLE_ROUTING_FILE = Path(__file__).with_name("role-routing.yaml")
ROLE_PROMPTS_DIR = Path(__file__).with_name("role-prompts")
PI_MCP_PROFILES_DIR = HOME / ".pi/agent/taskflow-profiles"

# Кого будить под какую учётку.
#
# До 21.08.2026 будильник знал ровно одного исполнителя: задача, назначенная
# на Гермеса или DeepSeek Harness, молча игнорировалась («исполнитель не я»),
# и назначение выглядело как поломка — владелец назначил, а никто не пришёл.
#
# Ключ — id учётки в TaskFlow, значение — как запустить агента с одним
# заданием: у каждого свой флаг разового запроса, интерактивную сессию тут
# поднимать нечем.
#
# ⚠️ Кто запускается Claude CLI — помечен флагом claude_cli и продолжает
# СВОЮ сессию по задаче между заходами (resume/форк, см. resume_target).
# У Гермеса, dsh и Antigravity продолжаемой сессии нет вовсе: каждый заход
# самостоятельный, поэтому им хватает одной команды.
LEGACY_EXTERNAL_AGENTS = {
    # Основной Claude_Bot использует тот же единый запуск, что и остальные
    # агенты. Раньше fallback в handle_task звал удалённую run_claude(), из-за
    # чего назначенные ему карточки не подхватывались (NameError).
    ME: {
        "id": ME,
        "name": "Claude_Bot",
        "token_env": "TASKFLOW_TOKEN",
        "vault_key": "TASKFLOW_TOKEN",
        "cmd": [CLAUDE_BIN, "--permission-mode", "bypassPermissions", "-p"],
        "claude_cli": True,
        "roles": ["researcher", "analyst", "synthesizer", "critic_verifier", "architect", "builder", "qa"],
    },
    "u3": {
        "name": "Гермес",
        "token_env": "TASKFLOW_HERMES_TOKEN",
        "cmd": [
            str(HOME / ".hermes/hermes-agent/.venv/bin/python"),
            "-m", "hermes_cli.main",
            # Набор инструментов под заход с доски (27.08.2026). Схемы всех
            # инструментов уходят в КАЖДЫЙ запрос внутри захода, а не при
            # первом обращении: в дампе 26.08 это 63 схемы на 80 КБ ≈ 27 тысяч
            # токенов, и платились они 65 раз подряд. Здесь оставлено то, чем
            # задача действительно делается; taskflow_* при этом остаются
            # доступны отложенно (deferred), их агент подтягивает сам.
            # Выброшены: session_search, delegation (раздаёт доска), clarify
            # (в headless некому отвечать), browser, tts, vision, skills, a2a
            # и 38 инструментов Мнемозины.
            "-t", "file,terminal,code_execution,todo,web,taskflow,memory",
            "-z",
        ],
        # Он умеет сам отчитаться о расходе захода — см. read_usage.
        "usage_flag": "--usage-file",
        # Каким флагом ему сказать модель, если на задаче висит метка.
        # У каждого агента он свой, поэтому живёт здесь, а не в коде запуска.
        "model_flag": "-m",
        # 29.08.2026: наряд уходит в ЖИВУЮ службу Гермеса (вебхук-маршрут
        # taskflow_task), а команда выше остаётся страховкой на случай, когда
        # служба молчит или полоса занята. Метка модели на задаче резидентом не
        # поддерживается и не может быть.
        # быть: живая сессия одна на все наряды суток, и модель у неё одна —
        # та, с которой поднялась служба. Метка сработает только на запасном
        # разовом заходе. Нужна другая модель осознанно — снимать резидента
        # с этой карточки, а не ждать, что метка подействует.
        "resident": True,
        "roles": ["researcher", "analyst", "synthesizer", "architect", "qa"],
    },
    # Оркестратор-Hermes СНЯТ 27.08.2026 по решению владельца: оркестратор
    # раскладывает работу и принимает её — это самая думающая роль, и слабая
    # модель там вредна. Обычный Гермес остаётся исполнителем (он же переведён
    # на подписку MiniMax), оркестратором остаётся Оркестратор-Claude ниже.
    # Учётка «Оркестратор Hermes» в базе и её токен в vault намеренно НЕ удалены —
    # если решение откатят, вернуть запись сюда достаточно, заводить заново нечего.
    # Прежний блок: профиль `-p orchestrator`, TASKFLOW_ORCHESTRATOR_HERMES_TOKEN,
    # role=orchestrator — см. git-историю этого файла.
    # Второй кандидат на ту же роль — под Claude Code, для сравнения, кто
    # лучше справляется с раздачей задач (Максим сравнивает Hermes vs
    # Claude/Opus/Fable вживую, назначая одну и ту же работу разным
    # оркестраторам). Своя учётка «Оркестратор Claude» — НЕ путать с u2
    # Claude_Bot: он идёт через run_external, своим токеном и своим
    # --mcp-config.
    #
    # 28.08.2026 он получил ту же непрерывность контекста, что и u2: заход
    # возвращается в прошлую сессию по задаче (claude_cli ниже). До этого
    # каждый заход был с чистого листа — полное вводное письмо и карточка
    # заново, ради одного действия, которое должен был доделать предыдущий
    # заход. Владелец: «получилось два раза за дороже, это глупость».
    "6848a89b-04fe-4015-bb1c-61b03782c378": {
        "name": "Оркестратор-Claude",
        "token_env": "TASKFLOW_ORCHESTRATOR_CLAUDE_TOKEN",
        "cmd": None,          # соберётся при старте, см. find_dsh()
        "env": {"PATH": "/home/maksim/.nvm/versions/node/v22.23.1/bin:"
                        + os.environ.get("PATH", "")},
        "role": "orchestrator",
        "vault_key": "TASKFLOW_ORCHESTRATOR_CLAUDE_TOKEN",
        "claude_cli": False,
        "roles": ["synthesizer", "critic_verifier", "architect"],
    },
    # DeepSeek Harness. Запускается из кеша npx — путь там меняется при
    # обновлении, поэтому ищем, а не зашиваем; PATH подменяем на Node 22,
    # на 18-м dsh падает с «node:util не отдаёт parseEnv».
    "b85212d6-abab-4afb-a4c6-0d379b6537a4": {
        "name": "DeepSeek Harness",
        "token_env": "TASKFLOW_DEEPSEEK_TOKEN",
        "cmd": None,          # соберётся при старте, см. find_dsh()
        "env": {"PATH": "/home/maksim/.nvm/versions/node/v22.23.1/bin:"
                        + os.environ.get("PATH", "")},
        "roles": ["researcher", "qa"],
    },
    # Antigravity — его родной CLI `agy`, как Гермес и dsh: свой агентский
    # цикл, доска через MCP. Самописный antigravity_agent.py больше не зовём —
    # он не доводил работу до конца (шаг не закрывал, на проверку не сдавал).
    # Обёртка рядом уводит запросы в свой выход; запускаем через bash, потому
    # что бит исполнения на скрипте не ставим.
    "5b9d47c1-25c7-4a7c-a276-70e21f7d7816": {
        "name": "Antigravity",
        "token_env": "TASKFLOW_ANTIGRAVITY_TOKEN",
        "cmd": [
            "/bin/bash",
            "/home/maksim/Проекты/New-Todoist/server/scripts/antigravity-cli.sh",
            "-p",
        ],
        # У agy короткого «-m» нет: на него он вываливает справку и не работает.
        "model_flag": "--model",
        # Свой выход в интернет, а не общий 10811: тот смотрит в Финляндию, а
        # оттуда Gemini API отвечает 400 «User location is not supported» — из-за
        # этого агент 24.08.2026 не мог сделать ни одного запроса. Перебором всей
        # подписки нашлись пускающие узлы (Нидерланды, Казахстан, UAE); выбранный
        # держит служба xray-antigravity.service, http 10814 / socks 10815.
        "env": {
            "HTTPS_PROXY": "http://127.0.0.1:10814",
            "HTTP_PROXY": "http://127.0.0.1:10814",
            "https_proxy": "http://127.0.0.1:10814",
            "http_proxy": "http://127.0.0.1:10814",
            "ALL_PROXY": "socks5://127.0.0.1:10815",
            "all_proxy": "socks5://127.0.0.1:10815",
        },
        "roles": ["analyst", "critic_verifier", "builder"],
    },
}

# Единая рабочая схема: старые записи выше оставлены как историческая
# документация, но в работу они больше не попадают и их ключи не читаются.
# Pi запускается своим CLI и получает единственный активный ключ TaskFlow.
EXTERNAL_AGENTS = {
    PI_AGENT_ID: {
        "id": PI_AGENT_ID,
        "name": "Pi Agent",
        "token_env": "TASKFLOW_TOKEN",
        "cmd": [PI_BIN, "-p"],
        "roles": sorted(ROLE_NAMES),
    },
}


# Заполняется один раз при старте и используется следующими этапами
# маршрутизации. Здесь пока только читаем и проверяем конфигурацию: выбор
# оболочки по роли подключается отдельной задачей, но невалидный файл уже
# сейчас должен остановить службу, а не дать ей работать с частичной картой.
def load_role_routing(path: Path = ROLE_ROUTING_FILE) -> dict[str, dict]:
    """Load and validate the role routing matrix from YAML."""
    try:
        import yaml
    except ImportError as exc:
        raise RuntimeError("для role-routing.yaml нужен пакет PyYAML") from exc

    try:
        document = yaml.safe_load(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise RuntimeError(f"не прочитать {path}: {exc}") from exc
    except yaml.YAMLError as exc:
        raise RuntimeError(f"невалидный YAML в {path}: {exc}") from exc

    if not isinstance(document, dict):
        raise ValueError("role-routing.yaml должен содержать mapping верхнего уровня")
    required = {"defaults", "fallbacks", "models"}
    if set(document) != required:
        missing = sorted(required - set(document))
        extra = sorted(set(document) - required)
        raise ValueError(
            "role-routing.yaml должен содержать ровно defaults, fallbacks и models; "
            f"пропущены: {missing}; лишние: {extra}"
        )

    sections: dict[str, dict] = {}
    for section_name in required:
        section = document[section_name]
        if not isinstance(section, dict):
            raise ValueError(f"{section_name} должен быть mapping")
        if set(section) != set(ROLE_NAMES):
            missing = sorted(ROLE_NAMES - set(section))
            extra = sorted(set(section) - ROLE_NAMES)
            raise ValueError(
                f"{section_name}: нужны все роли; "
                f"пропущены: {missing}; лишние: {extra}"
            )
        sections[section_name] = section

    for role in sorted(ROLE_NAMES):
        default = sections["defaults"][role]
        if not isinstance(default, str) or not default.strip():
            raise ValueError(f"defaults.{role} должен быть непустой строкой")

        fallbacks = sections["fallbacks"][role]
        if not isinstance(fallbacks, list):
            raise ValueError(f"fallbacks.{role} должен быть списком")
        if any(not isinstance(item, str) or not item.strip() for item in fallbacks):
            raise ValueError(f"fallbacks.{role} должен содержать только непустые строки")
        if len(fallbacks) != len(set(fallbacks)):
            raise ValueError(f"fallbacks.{role} не должен содержать дубликаты")

        model = sections["models"][role]
        if not isinstance(model, str) or not model.strip():
            raise ValueError(f"models.{role} должен быть непустой строкой")

    return sections


SHELL_AGENT_IDS = {
    # Исторические имена сохраняем для старых карточек и отображения.
    "agent_claude_bot": "u2",
    "agent_hermes": "u3",
    "agent_orchestrator": "6848a89b-04fe-4015-bb1c-61b03782c378",
    "agent_deepseek": "b85212d6-abab-4afb-a4c6-0d379b6537a4",
    "agent_antigravity": "5b9d47c1-25c7-4a7c-a276-70e21f7d7816",
    "agent_pi": PI_AGENT_ID,
}
ROLE_ROUTING = load_role_routing()


def task_role(task: dict) -> str:
    """Return the seven-role name carried by a task or its assignee."""
    for key in ("role", "assignee_role"):
        value = str(task.get(key) or "").strip().lower()
        if value in ROLE_NAMES:
            return value
    return ""


def role_prompt_for_task(task: dict) -> str:
    """Read the role prompt for a task, failing loudly when it is missing."""
    role = task_role(task)
    if not role:
        return ""
    path = ROLE_PROMPTS_DIR / f"{role}.md"
    try:
        prompt = path.read_text(encoding="utf-8").strip()
    except OSError as exc:
        raise RuntimeError(f"не прочитать системный prompt роли {role}: {path}: {exc}") from exc
    if not prompt:
        raise RuntimeError(f"пустой системный prompt роли {role}: {path}")
    return prompt


def pi_mcp_profile_for_role(role: str) -> Path | None:
    """Return the explicit Pi MCP profile for a routed role.

    A task without a role deliberately returns ``None``: a normal Pi launch
    must keep using ``~/.pi/agent/mcp.json`` and must not inherit a role by
    accident.
    """
    role_name = str(role or "").strip().lower()
    if not role_name:
        return None
    if role_name not in ROLE_NAMES:
        raise ValueError(f"неизвестная роль для MCP-профиля Pi: {role}")
    path = PI_MCP_PROFILES_DIR / f"{role_name}.json"
    if not path.is_file():
        raise RuntimeError(f"не найден MCP-профиль Pi для роли {role_name}: {path}")
    return path


def pi_skill_paths_for_role(role: str) -> list[Path]:
    """Return the explicit skills declared by a role's Pi profile."""
    profile = pi_mcp_profile_for_role(role)
    try:
        document = json.loads(profile.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"не прочитать MCP-профиль Pi {profile}: {exc}") from exc
    raw_skills = document.get("skills", [])
    if raw_skills is None:
        return []
    if not isinstance(raw_skills, list) or any(
        not isinstance(skill, str) or not skill.strip() for skill in raw_skills
    ):
        raise ValueError(f"{profile}: skills должен быть списком непустых путей")
    skills = [Path(os.path.expanduser(skill)).resolve() for skill in raw_skills]
    missing = [str(skill) for skill in skills if not skill.exists()]
    if missing:
        raise RuntimeError(f"{profile}: не найдены skills: {', '.join(missing)}")
    return skills


def validate_pi_mcp_profiles() -> None:
    """Validate role profiles before the trigger accepts work."""
    for role in sorted(ROLE_NAMES):
        path = pi_mcp_profile_for_role(role)
        try:
            document = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"не прочитать MCP-профиль Pi {path}: {exc}") from exc
        try:
            env = document["mcpServers"]["taskflow"]["env"]
        except (KeyError, TypeError) as exc:
            raise ValueError(f"в MCP-профиле Pi {path} нет mcpServers.taskflow.env") from exc
        if env.get("TASKFLOW_VAULT_KEY") != "TASKFLOW_PI_AGENT_TOKEN":
            raise ValueError(f"{path}: нужен TASKFLOW_PI_AGENT_TOKEN")
        if env.get("TASKFLOW_MCP_ROLE") != role:
            raise ValueError(f"{path}: TASKFLOW_MCP_ROLE не совпадает с именем роли")
        if not str(env.get("TASKFLOW_MCP_TOOLS") or "").strip():
            raise ValueError(f"{path}: пустой TASKFLOW_MCP_TOOLS")
        pi_skill_paths_for_role(role)


def resolve_agent_for_role(role: str) -> dict | None:
    """Select the configured shell for a role, preferring its default."""
    role_name = str(role or "").strip().lower()
    if role_name not in ROLE_NAMES:
        raise ValueError(f"неизвестная роль: {role}")

    candidates = [("дефолт", ROLE_ROUTING["defaults"][role_name])]
    candidates.extend(("фолбэк", shell) for shell in ROLE_ROUTING["fallbacks"][role_name])
    for reason, shell in candidates:
        agent_id = SHELL_AGENT_IDS.get(shell)
        agent = EXTERNAL_AGENTS.get(agent_id or "")
        if agent is None or role_name not in agent.get("roles", []):
            continue
        selected = dict(agent)
        selected["id"] = agent_id
        selected["routing_shell"] = shell
        selected["routing_reason"] = reason
        log(f"роль {role_name}: оболочка {shell} ({reason})")
        return selected

    log(f"роль {role_name}: доступной оболочки нет")
    return None


def validate_role_agents(routing: dict[str, dict]) -> None:
    """Ensure every routing reference names a shell allowed for that role."""
    for role in sorted(ROLE_NAMES):
        shells = [routing["defaults"][role], *routing["fallbacks"][role]]
        for shell in shells:
            agent_id = SHELL_AGENT_IDS.get(shell)
            agent = EXTERNAL_AGENTS.get(agent_id or "")
            if agent is None:
                raise ValueError(f"{role}: оболочка {shell} не зарегистрирована")
            if role not in agent.get("roles", []):
                raise ValueError(f"{role}: оболочка {shell} не разрешена полем roles")


# Модель задаётся МЕТКОЙ НА ЗАДАЧЕ. Решение владельца 21.08.2026: «меткой
# гораздо гибче и проще менять, чем каждый раз заходить в настройки перед
# назначением» — метка вешается и снимается в один тап, в том числе с
# телефона и уже после назначения.
#
# Метки нет — ничего не подставляем: у CLI своё умолчание (модель подписки),
# и подменять его догадкой значит менять поведение там, где никто не просил.
#
# Имена совпадают с псевдонимами Claude Code; Гермесу они не подойдут — ему
# метку вешать с его собственным именем модели, поэтому распознаём и
# произвольное значение через префикс «модель:».
# Повод захода «владелец написал по сданной задаче»: отвечаем в ленте и
# уходим, не трогая ни карточку, ни шаги. Строкой, потому что повод и так
# едет через все запуски параметром reason — второй канал не нужен.
REPLY_ONLY = "владелец написал по задаче на проверке — отвечаю, не забирая её"

MODEL_LABELS = {"opus", "sonnet", "haiku", "fable"}

# Чем ходит Antigravity, когда метки на задаче нет. GPT-OSS выбран не по
# силе, а по цене: владелец 29.08.2026 — «лимиты на Sonnet и Opus очень
# маленькие, лучше оставь на GPT, она экономнее». Модели Gemini сюда
# ставить нельзя ни в каком виде: в нашем регионе они отвечают отказом.
# Модель по умолчанию для Antigravity. 29.08.2026 владелец: «на край
# антигравити с моделью сонет» — после того как gpt-oss-120b на карточке
# времени закрыл два шага ложно и уронил сборку фронта в 11 файлах.
# Лимит Sonnet у него скудный, поэтому Antigravity и стоит последним в
# очереди раздачи: сначала Гермес, потом локальная модель DeepSeek.
ANTIGRAVITY_DEFAULT_MODEL = "claude-sonnet-4-6"

# {task_id: модель}, о которой уже сказано в ленте этой карточки. Держит
# строку «Заход выполнен на модели…» от повторов внутри цепочки заходов —
# см. место записи ниже. Живёт в памяти процесса: после перезапуска службы
# сообщение повторится один раз, и это не беда.
_MODEL_NOTED: dict[str, str] = {}

ANTIGRAVITY_MODEL_ALIASES = {
    # Порядок уровней — по прайсу Anthropic, откуда имена и взяты (см.
    # DSH_MODEL_ALIASES ниже): fable дороже и мощнее opus. Своей модели
    # уровня Fable у Antigravity нет, поэтому метка ведёт на самое сильное,
    # что у него есть, — туда же, куда opus. До 27.08.2026 fable ошибочно
    # вёл на дешёвую flash, то есть означал прямо противоположное.
    "fable": "claude-opus-4-6-thinking",
    "opus": "claude-opus-4-6-thinking",
    "sonnet": "claude-sonnet-4-6",
    # haiku вёл на gemini-3.5-flash — она в нашем регионе не отвечает вовсе
    # (см. комментарий у ANTIGRAVITY_DEFAULT_MODEL). Дешёвый уровень теперь
    # закрывает GPT-OSS: работает и не ест скудный лимит Sonnet/Opus.
    "haiku": "gpt-oss-120b-medium",
    "claude-sonnet-4.6": "claude-sonnet-4-6",
    "claude-opus-4.6": "claude-opus-4-6-thinking",
    "gpt-oss-120b": "gpt-oss-120b-medium",
    "3.7-flash": "gemini-3.7-flash-high",
    "3.6-flash": "gemini-3.6-flash-high",
    "3.5-flash": "gemini-3.5-flash-high",
    "3.1-pro": "gemini-3.1-pro-high",
    "gemini-3.7-flash": "gemini-3.7-flash-high",
    "gemini-3.6-flash": "gemini-3.6-flash-high",
    "gemini-3.5-flash": "gemini-3.5-flash-high",
    "gemini-3.1-pro": "gemini-3.1-pro-high",
    "gemini-3.1-pro-preview": "gemini-3.1-pro-high",
    "gemini-3-flash-preview": "gemini-3.7-flash-high",
    "gemini-2.5-pro": "gemini-3.1-pro-high",
}


# DeepSeek Harness: метка → (провайдер, модель) в его собственных настройках.
#
# Флага модели у dsh нет вовсе — он берёт её только из `agent-default-model`
# в `~/.dsh/settings.yaml`. Патч профиля (`--patch`) не помогает: проверено
# 27.08.2026 фактом — composition entry меняется, а живой заход всё равно
# идёт на модель из settings.yaml, то есть настройки перекрывают патч.
# Работает единственный путь — подменить сам ДОМ dsh (`DSH_HOME`), см.
# dsh_home_for() ниже.
#
# Порядок уровней — по прайсу Anthropic, откуда сами имена и взяты
# (проверено 27.08.2026 по platform.claude.com/docs, $ за млн токенов
# вход/выход):
#   Fable 5   $10/$50   ← самая дорогая и мощная
#   Opus 5     $5/$25
#   Sonnet 5   $2/$10
#   Haiku 4.5  $1/$5    ← самая дешёвая
# Каждая ступень ровно вдвое дешевле предыдущей. Владелец 27.08.2026 поймал
# здесь ошибку: fable стоял на самой дешёвой модели («идёт во всех
# документах и в реальности как самая дорогущая — тем самым вводишь в
# заблуждение всё, что только можно»). Раскладка развёрнута по прайсу.
DSH_MODEL_ALIASES = {
    "fable": ("minimax", "MiniMax-M3"),               # топ: контекст 1 млн
    "opus": ("minimax", "MiniMax-M2.7"),              # рабочая
    "sonnet": ("minimax", "MiniMax-M2.7-highspeed"),  # быстрая
    # Локальная Qwen: не тратит общий с Гермесом лимит подписки MiniMax.
    "haiku": ("ollama", "qwen3.6-27b-iq4-16k:latest"),
}

DSH_SETTINGS = HOME / ".dsh/settings.yaml"
# Что связываем в подменный дом. Симлинки, не копии: профили несут патч-слой
# с MCP доски, а `.credentials.yaml` обновляется, когда Гермес перелогинится
# в MiniMax, — копия к этому моменту протухнет молча.
DSH_HOME_LINKS = ("profiles", "sessions", "storages", ".credentials.yaml", "AGENTS.md")


def model_of(task: dict) -> str:
    """Модель из меток задачи или пустая строка.

    Понимаем два вида метки: короткое имя из списка выше («Sonnet») и явную
    форму «модель: что-угодно» — вторая нужна тем исполнителям, у кого свои
    имена моделей, длинные и с косыми чертами.

    Все прочие метки владельца («Важно», «UX/UI», «Дом») проходят мимо: они
    не совпадают ни со списком, ни с префиксом. Метки — его инструмент, и
    заводить их он должен свободно, не оглядываясь на будильник.
    """
    found: list[str] = []
    for label in task.get("labels") or []:
        name = str(label.get("name") or "").strip()
        low = name.lower()
        if low in MODEL_LABELS:
            found.append(low)
            continue
        for prefix in ("модель:", "model:"):
            if low.startswith(prefix):
                value = name[len(prefix):].strip()
                if value:
                    found.append(value)
                break
    if not found:
        role = task_role(task)
        if role:
            return ROLE_ROUTING["models"][role]
        return ""
    # Две метки моделей сразу — не ошибка владельца, а недосмотр: скорее
    # всего забыл снять прежнюю. Берём первую и ГОВОРИМ об этом в журнале,
    # иначе задача молча уйдёт не на той модели, а по карточке не понять,
    # почему.
    if len(found) > 1:
        log(f"  ⚠️ на задаче несколько меток модели ({', '.join(found)})"
            f" — беру первую: {found[0]}")
    return found[0]


def dsh_model_route(model: str) -> tuple[str, str] | None:
    """Метка → (провайдер, модель) для dsh или None, если такой модели нет.

    Короткие имена берём из карты уровней, произвольные («модель:...») —
    ищем среди моделей, объявленных в живом settings.yaml. Не нашли —
    возвращаем None: подставлять догадку значит уронить заход в
    MISSING_CREDENTIAL или NO_ADAPTER.
    """
    low = model.strip().lower()
    if low in DSH_MODEL_ALIASES:
        return DSH_MODEL_ALIASES[low]
    try:
        import yaml  # есть в окружении сервера
        conf = yaml.safe_load(DSH_SETTINGS.read_text()) or {}
    except Exception as exc:                     # noqa: BLE001
        log(f"  ⚠️ не прочитать {DSH_SETTINGS}: {exc}")
        return None
    providers = ((conf.get("llm-pi-ai") or {}).get("providers") or {})
    for provider, spec in providers.items():
        for entry in (spec or {}).get("models") or []:
            mid = str((entry or {}).get("id") or "")
            if mid and mid.lower() == low:
                return provider, mid
    return None


def dsh_home_for(model: str) -> str:
    """Готовит подменный DSH_HOME под нужную модель. Пусто — идти на умолчании.

    Дом на модель переиспользуется, но settings.yaml пересобирается каждый
    раз из настоящего: провайдеры и ключи там могут поменяться, и застывшая
    копия тихо увела бы заход на старую конфигурацию.

    ⚠️ Настройки правим ТЕКСТОМ, а не через yaml.safe_dump. Разобрать и
    записать обратно нельзя: в файле есть ключ `off:` (уровень раздумий у
    моделей Polza), а в YAML 1.1 это булево — при записи он превращается в
    `false:`, плагин моделей отвергает такой блок целиком, и заход падает с
    «NO_ADAPTER: no adapter registered». Проверено 27.08.2026 живым заходом.
    """
    route = dsh_model_route(model)
    if route is None:
        log(f"  ⚠️ метка модели «{model}» неизвестна dsh — иду на умолчании из настроек")
        return ""
    provider, model_id = route
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", f"{provider}-{model_id}").strip("-")
    home = STATE_DIR / "dsh-homes" / slug
    home.mkdir(parents=True, exist_ok=True)
    for name in DSH_HOME_LINKS:
        target = HOME / ".dsh" / name
        link = home / name
        if not target.exists():
            continue
        if link.is_symlink() and os.readlink(link) == str(target):
            continue
        if link.is_symlink() or link.exists():
            link.unlink()
        link.symlink_to(target)

    try:
        text = DSH_SETTINGS.read_text()
    except OSError as exc:
        log(f"  ⚠️ не прочитать {DSH_SETTINGS}: {exc} — иду на умолчании")
        return ""
    section = f"agent-default-model:\n  provider: {provider}\n  model: {model_id}\n"
    lines, out, i, replaced = text.splitlines(keepends=True), [], 0, False
    while i < len(lines):
        if lines[i].startswith("agent-default-model:"):
            out.append(section)
            replaced = True
            i += 1
            # тело секции — всё, что с отступом (в том числе комментарии)
            while i < len(lines) and (lines[i][:1] in (" ", "\t") or not lines[i].strip()):
                i += 1
            continue
        out.append(lines[i])
        i += 1
    if not replaced:
        log("  ⚠️ в настройках dsh нет секции agent-default-model — дописываю")
        out.append(section)
    tmp = home / "settings.yaml.tmp"
    tmp.write_text("".join(out))
    os.replace(tmp, home / "settings.yaml")

    # ГЛАВНАЯ ПРОВЕРКА. Без неё сбой был бы ТИХИМ: заход спокойно уходит на
    # прежней модели, метка на карточке ни на что не влияет, и по журналу не
    # понять почему. Поэтому перечитываем то, что записали, и если модель не
    # та — честно идём на умолчании, но с криком в журнал.
    try:
        import yaml
        back = yaml.safe_load((home / "settings.yaml").read_text()) or {}
        got = back.get("agent-default-model") or {}
    except Exception as exc:                     # noqa: BLE001
        log(f"  ⚠️ подменный дом dsh не перечитывается: {exc} — иду на умолчании")
        return ""
    if (got.get("provider"), got.get("model")) != (provider, model_id):
        log(f"  ⚠️ подменный дом dsh собран неверно ({got}) — иду на умолчании")
        return ""
    return str(home)


def find_dsh() -> list[str] | None:
    """Команда запуска dsh в headless-режиме или None, если его нет."""
    direct = HOME / ".npm-global/bin/dsh"
    if direct.exists():
        return [str(direct), "--profile", "headless"]
    cache = HOME / ".npm/_npx"
    if cache.is_dir():
        for entry in sorted(cache.iterdir()):
            candidate = entry / "node_modules/.bin/dsh"
            if candidate.exists():
                return [str(candidate), "--profile", "headless"]
    return None
OWNER = "u1"     # Максим
HEARTBEAT_SEC = 90    # аренда живёт 5 минут — сигнал втрое чаще, с запасом
                      # на пару пропущенных подряд (сеть, занятый сервер)
# Сколько ждать, пока занятая сессия освободится, прежде чем работать
# форком. Ход агента редко длится дольше пары минут; ждать бесконечно
# нельзя — задача повиснет молча.
BUSY_WAIT_SEC = 8 * 60
BUSY_POLL_SEC = 15
PROJECTS_DIR = HOME / ".claude/projects"
RUNNING: dict[str, tuple[subprocess.Popen | None, str]] = {}
# Значение — (proc, assignee_id). assignee_id нужен обходу доски: проверить,
# занят ли конкретный агент, не сделав N запросов в API, чтобы свериться с
# сервером по каждой карточке в RUNNING.
LOCK = threading.Lock()

# Страховка к будильнику: свой обход доски раз в несколько минут.
#
# Зачем он, если будильник и так реагирует на уведомления WS. Случаи, которые
# уведомления НЕ ловят, а доска молча показывает «назначено, не взято»:
#   - служба лежала, пока владелец назначал задачу, и уведомление протухло;
#   - владелец назначил задачу, которая уже была активна у того же агента под
#     другой меткой сессии, и сервер не счёл это новым событием;
#   - сам агент назначил задачу (в рамках координационной работы оркестратора)
#     и тут же закончился процесс — уведомлений не было вовсе, а исполнитель
#     даже не догадывается, что у него появилась работа.
# Прецедент 29.08.2026: три задачи стояли назначенными и свободными, никто их
# не брал, и понять это можно было только заглянув в базу руками.
#
# Не трогает: основной путь пробуждения по уведомлениям — это и остаётся
# главным. Аренду, правила приёмки, матрицу переходов — тоже. Это только
# обход доски, которого раньше не было.
#
# Порог «не брали дольше» подобран под живые заходы: уведомление о назначении
# приходит за секунды, и за 2 минуты нормальный ход уже сдвинулся бы. Если за
# это время ничего не произошло — карточка зависла, и доска молчит, потому
# что звать было некому.
BOARD_SCAN_SEC = 3 * 60          # раз в 3 минуты — часто, но не лавина
BOARD_SCAN_MIN_AGE_MIN = 2       # не трогать свежие: уведомление ещё в пути
BOARD_SCAN_STATE_PATH = STATE_DIR / "board-scan.state.json"
# Занят ли агент ЛЮБОЙ другой задачей. Если да — звать его за этой не нужно,
# чтобы не сжечь лавину запросов поверх идущего хода. Проверяем оба слоя:
# локальный (RUNNING — есть процесс на его задаче) и серверный (есть активная
# аренда у задач этого исполнителя). RUNNING отражает «мы запустили ход прямо
# сейчас», сервер — «где-то держится аренда».
BOARD_SCAN_BUSY_HEARTBEAT_MIN = 1  # аренда свежее минуты — точно занят


def log(msg: str) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    line = f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {msg}"
    print(line, flush=True)
    with LOG_FILE.open("a") as f:
        f.write(line + "\n")


def api(method: str, path: str, body=None, token: str = ""):
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Authorization": f"Bearer {token or TOKEN}"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(API + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        log(f"  API {method} {path} → {e.code}: {e.read().decode()[:160]}")
        return None
    except Exception as e:  # сеть/таймаут — не роняем службу
        log(f"  API {method} {path} → {e}")
        return None


def get_task(task_id: str):
    d = api("GET", f"/api/tasks/{task_id}")
    if not d:
        return None
    return d.get("task", d)


def _load_scan_state() -> dict[str, str]:
    """Карта {task_id: last_seen_iso}, чтобы не будить ту же карточку дважды
    подряд между перезапусками службы. Без неё свежий старт разбудил бы всё,
    что уже разбужено в прошлый раз, но ещё не отметилось движением — а
    service restart бывает часто (правки юнита, обновления кода).
    """
    try:
        raw = json.loads(BOARD_SCAN_STATE_PATH.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {}
    return {k: v for k, v in raw.items() if isinstance(k, str) and isinstance(v, str)}


def _save_scan_state(state: dict[str, str]) -> None:
    """Пишем мягко: сбой записи на диск не должен ронять сторож."""
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        tmp = BOARD_SCAN_STATE_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(state))
        os.replace(tmp, BOARD_SCAN_STATE_PATH)
    except OSError as exc:
        log(f"  ⚠️ не записать {BOARD_SCAN_STATE_PATH}: {exc}")


def _agent_already_busy(assignee_id: str) -> bool:
    """Занят ли агент ЛЮБОЙ другой задачей прямо сейчас.

    Два слоя:
      1. Локальный RUNNING: у нас уже крутится процесс по одной из ЕГО задач —
         это самый свежий и точный сигнал, и он важнее серверного. RUNNING
         хранит (proc, owner_assignee_id), и фильтр именно по нему: чужие
         процессы (Гермеса, dsh, Antigravity) не делают DeepSeek «занятым».
      2. Серверный `agent_state='in_progress'` со свежей арендой: процесс мог
         быть запущен другой сессией/службой, и RUNNING его не видит.

    True — звать за новой карточкой НЕ нужно, иначе сожжём лавину запросов
    поверх идущего хода. Это и есть та самая «не буди лавину» из задачи.
    """
    # Слой 1: локально, ТОЛЬКО по задачам этого исполнителя
    with LOCK:
        for entry in RUNNING.values():
            proc, who = entry
            if who != assignee_id:
                continue
            if proc is None:
                # процесс ещё не стартовал, но место занято — считаем занятым
                return True
            if proc.poll() is None:
                return True
    # Слой 2: сервер. Один проход по задачам — `/api/tasks` и так всё
    # возвращает, лишний запрос делать незачем. Карточки нас не интересуют:
    # только факт «у этого исполнителя есть свежая аренда».
    tasks = api("GET", "/api/tasks") or []
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=BOARD_SCAN_BUSY_HEARTBEAT_MIN)
    for t in tasks:
        if t.get("assignee_id") != assignee_id:
            continue
        if t.get("status") != "active" or t.get("agent_state") != "in_progress":
            continue
        beat = t.get("agent_heartbeat_at")
        if not beat:
            continue
        try:
            beat_dt = datetime.fromisoformat(beat.replace(" ", "T")).replace(
                tzinfo=timezone.utc
            )
        except ValueError:
            continue
        if beat_dt >= cutoff:
            return True
    return False


def _orphans_for_assignees() -> dict[str, list[dict]]:
    """Словарь {assignee_id: [task, ...]} — задачи в активном статусе, с
    исполнителем, но никем не взятые (agent_state IS NULL) и старше порога.

    Один проход по `/api/tasks` вместо запроса на каждую карточку: список
    там и так полный (агент видит всё с 18.08.2026), а фильтры узкие.
    """
    tasks = api("GET", "/api/tasks") or []
    out: dict[str, list[dict]] = {}
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=BOARD_SCAN_MIN_AGE_MIN)
    for t in tasks:
        if t.get("status") != "active":
            continue
        if t.get("agent_state") is not None:
            continue                          # кто-то уже взял или сдал
        assignee = t.get("assignee_id")
        if not assignee:
            continue                          # «без исполнителя» — не наш сигнал
        if assignee != ME and assignee not in EXTERNAL_AGENTS:
            continue                          # исполнитель — не наш агент
        created = t.get("created_at")
        if not created:
            continue
        try:
            created_dt = datetime.fromisoformat(created.replace(" ", "T")).replace(
                tzinfo=timezone.utc
            )
        except ValueError:
            continue
        if created_dt > cutoff:
            continue                          # ещё молодая, уведомление в пути
        out.setdefault(assignee, []).append(t)
    return out


def board_scan() -> None:
    """Один проход: найти зависшие карточки и позвать по ним исполнителей.

    Не зовёт занятых — это и есть главный предохранитель от лавины. Каждую
    карточку будит ровно один раз между событиями: если заход стартовал и
    взял её (agent_state перестал быть NULL), следующий проход её уже не
    увидит. Если заход НЕ стартовал (агент занят) — пометка останется в
    state-файле, и мы попробуем снова на следующем круге: ждать лучше, чем
    потерять карточку молча.
    """
    orphans = _orphans_for_assignees()
    if not orphans:
        # Пустой прогон тоже фиксируем: при следующем рестарте нечего
        # забывать, и состояние чистится само собой.
        _save_scan_state({})
        return

    seen = _load_scan_state()
    now_iso = datetime.now(timezone.utc).isoformat(timespec="seconds")

    for assignee_id, tasks in orphans.items():
        if _agent_already_busy(assignee_id):
            log(f"  обход: «{assignee_id}» занят другой задачей — пропускаю "
                f"{len(tasks)} зависших")
            continue
        owner_id = assignee_id  # соединение, через которое мы зовём
        for task in tasks:
            tid = task.get("id")
            if not tid:
                continue
            if seen.get(tid) == now_iso:
                continue                          # уже разбудили в этом круге
            log(f"  обход: «{task.get('title') or '(без названия)'}» висит "
                f"назначенной и не взятой — будю «{assignee_id}»")
            seen[tid] = now_iso
            handle_task(tid, "обход доски: задача назначена и не взята",
                        owner_id=owner_id)

    # Чистим state от того, чего больше нет в активных: иначе через месяц
    # файл разрастётся под тысячу id, которые доска уже съела.
    active_ids = {t.get("id") for tasks in orphans.values() for t in tasks}
    seen = {k: v for k, v in seen.items() if k in active_ids}
    _save_scan_state(seen)


def board_scan_loop() -> None:
    """Сторожевой поток: периодически зовёт board_scan(), пока служба жива.

    Запускается отдельным daemon-потоком из main() — не блокирует WS и не
    мешает основному пути пробуждения по уведомлениям.
    """
    # На старте небольшая задержка: пусть WS-соединения поднимутся и успеют
    # добрать пропущенное, прежде чем мы добавим СВОЙ повод сверху.
    if os.environ.get("TASKFLOW_TRIGGER_DRY") == "1":
        log(f"[сухой прогон] обход доски отключён")
        return
    time.sleep(BOARD_SCAN_SEC)
    while True:
        try:
            board_scan()
        except Exception as exc:                 # noqa: BLE001
            log(f"  ⚠️ обход доски упал: {exc}")
        time.sleep(BOARD_SCAN_SEC)


def decide(task: dict, kind: str = "", actor_id: str = "") -> tuple[bool, str]:
    """Браться ли за задачу. Тумблер тот же, что у Максима на доске Kaneo:
    явное назначение агента исполнителем и есть «этой задачей заниматься
    можно». Без назначения служба молчит, что бы в задаче ни происходило."""
    if not task:
        return False, "задачи нет"
    task_id = task.get("id")
    assignee = task.get("assignee_id")
    if assignee != ME and assignee not in EXTERNAL_AGENTS:
        return False, "исполнитель не я"
    if task.get("status") != "active":
        return False, "задача не активна"
    
    with LOCK:
        entry = RUNNING.get(task_id)
        if entry is None:
            is_running = False
        else:
            proc, _who = entry
            is_running = proc is None or proc.poll() is None
    if is_running:
        return False, "уже в работе (процесс активен)"

    state = task.get("agent_state")
    if state == "review":
        # Владелец написал по сданной задаче — это не «проверка идёт», это
        # вопрос, адресованный исполнителю. Молчать в ответ нельзя: 27.08.2026
        # Максим дважды написал по карточке в review и не получил ничего,
        # потому что будильник считал её закрытой темой. Отвечаем — но
        # карточку не забираем, приёмка остаётся за ним (см. REPLY_ONLY).
        # ⚠️ Только на ЧУЖОЙ комментарий. Ответ самого исполнителя порождает
        # уведомление создателю задачи, оно приходит в соединение службы — и
        # без этой проверки агент будит сам себя по кругу. Поймано живьём
        # 27.08.2026: DeepSeek ответил четыре раза подряд на один вопрос.
        if kind == "commented" and actor_id and actor_id != assignee:
            return True, REPLY_ONLY
        return False, "ждёт проверки владельца"
    if state == "blocked":
        return False, "заблокирована, ждёт владельца"
    return True, "назначена на меня / требует выполнения"


def live_sessions() -> dict:
    """Живые сессии Claude Code: {session_id: "busy"|"idle"|...}.

    `claude agents --json` для того и сделан — печатает и интерактивные, и
    фоновые сессии без TTY. Пусто (или сбой) — считаем, что живых нет:
    для нас это лишь подсказка «занята ли», а не источник истины о том,
    существует ли сессия вообще (та живёт транскриптом на диске).
    """
    try:
        out = subprocess.run(
            [CLAUDE_BIN, "agents", "--json"],
            capture_output=True, text=True, timeout=30,
        )
        items = json.loads(out.stdout or "[]")
    except Exception as e:
        log(f"  не смог получить список сессий: {e}")
        return {}
    return {
        it.get("sessionId"): (it.get("status") or it.get("state") or "unknown")
        for it in items if it.get("sessionId")
    }


def transcript_exists(session_id: str) -> bool:
    """Сессию можно продолжить, пока цел её транскрипт — даже если процесса
    давно нет. Имя файла = <session_id>.jsonl, папка зависит от каталога,
    в котором сессия работала, поэтому ищем по всем проектам."""
    if not session_id:
        return False
    return any(PROJECTS_DIR.glob(f"**/{session_id}.jsonl"))


def wait_until_free(session_id: str) -> str:
    """Дождаться, пока сессия перестанет быть занятой.

    Перебить чужой ход невозможно: процесс досчитает начатое. Поэтому
    «будильник главнее» реализуется ожиданием, а не насилием — и только
    если сессия не освободилась за BUSY_WAIT_SEC, заход уходит в форк
    (там свой номер, оригинал не трогается: два процесса на одном номере
    писали бы в один транскрипт).
    """
    waited = 0
    while waited < BUSY_WAIT_SEC:
        status = live_sessions().get(session_id)
        if status != "busy":
            return status or "нет живого процесса"
        time.sleep(BUSY_POLL_SEC)
        waited += BUSY_POLL_SEC
        if waited % 60 == 0:
            log(f"  сессия {session_id[:8]} всё ещё занята, жду ({waited // 60} мин)")
    return "busy"


def resume_target(task: dict, token: str = "") -> tuple[str, str, bool]:
    """Куда возвращаться этим заходом: (resume_sid, new_sid, fork).

    Общая механика для ВСЕХ агентов на Claude CLI — и для пути Claude_Bot
    (run_claude), и для учёток из EXTERNAL_AGENTS с флагом claude_cli.
    До 28.08.2026 она жила только внутри run_claude, и поэтому
    Оркестратор-Claude, у которого своя учётка, каждый заход начинал с
    чистого листа: полное вводное письмо заново, карточка вкуривается
    заново, и всё это ради одного действия, которое должен был доделать
    предыдущий заход. Владелец: «получилось два раза за дороже».

    ⚠️ Читать ОБЯЗАТЕЛЬНО до claim: claim пишет agent_session_id тем, что
    пришло в теле запроса, без COALESCE (routes/agent-state.ts). Точная
    цена пустого тела, проверено живьём 28.08.2026: на ПЕРВОМ взятии
    колонка так и остаётся пустой (возвращаться потом некуда), а на
    перезахвате после протухшей аренды — обнуляется. Пока аренда свежа,
    повторный claim просто отклоняется (400), там ничего не портится.

    Сессии нет (не было или транскрипт не сохранился) — честная пометка в
    ленту: иначе это выглядит как «агент забыл всё, что обсуждали».
    """
    prev_sid = (task.get("agent_session_id") or "").strip()
    resume_sid = prev_sid if transcript_exists(prev_sid) else ""
    fork = False
    if resume_sid:
        if live_sessions().get(resume_sid) == "busy":
            log(f"  сессия {resume_sid[:8]} занята — жду, пока освободится")
            if wait_until_free(resume_sid) == "busy":
                # Не дождались: работаем форком, чтобы не писать вторым
                # процессом в тот же транскрипт. Контекст сохраняется,
                # номер будет новый.
                fork = True
                log(f"  сессия {resume_sid[:8]} так и занята — иду форком")
    else:
        if prev_sid:
            text = (f"Прежней сессии {prev_sid[:8]}… больше нет на диске — "
                    "начинаю с чистого листа, помню только то, что записано в карточке.")
        else:
            text = ("По этой задаче ещё не было сессии агента — начинаю с чистого листа, "
                    "помню только то, что записано в карточке.")
        api("POST", f"/api/tasks/{task['id']}/comments", {"text": text}, token=token)
    new_sid = str(uuid.uuid4()) if (not resume_sid or fork) else resume_sid
    return resume_sid, new_sid, fork


def claude_session_args(resume_sid: str, new_sid: str, fork: bool) -> list[str]:
    """Аргументы CLI под выбранную сессию — одни и те же у обоих путей."""
    if resume_sid and not fork:
        return ["--resume", resume_sid]
    if resume_sid and fork:
        return ["--resume", resume_sid, "--fork-session", "--session-id", new_sid]
    return ["--session-id", new_sid]


def _render_ctx(ctx) -> str:
    """Шаг 4 ТЗ: единый сериализатор TaskContext v1 для prompt.
    Делегирует task_context.serialize_context() — там же применяется лимит
    MAX_TOTAL_CHARS=6000, обрезка excerpts/references/dirty_files и пр."""
    if ctx is None:
        return ""
    from task_context import serialize_context
    return serialize_context(ctx)


def build_resume_prompt(task: dict, reason: str, ctx=None) -> str:
    """Промпт для ПРОДОЛЖЕНИЯ своей же сессии: она помнит и задачу, и что
    уже сделано, поэтому пересказывать карточку целиком не нужно — нужен
    только повод и свежая лента."""
    comments = "\n".join(
        f"  {c.get('user_name')}: {c.get('text')}"
        for c in (task.get("comments") or [])[-3:]
    )
    return f"""Доска TaskFlow снова зовёт по задаче «{task.get('title')}»: {reason}.

Это та же задача, над которой ты уже работал в этой сессии — контекст у
тебя есть, начинать заново не нужно.

Свежее в ленте:
{comments or '  (пусто)'}

Задача уже взята в работу службой, аренду продлевает она же. Закончил —
закрывай шаги и саму задачу (completed) сам, с result; упёрся —
blocked с объяснением, чего ждёшь от Максима (не от другого агента/сессии —
на пира просто оставайся in_progress).
    {_render_ctx(ctx)}
"""


def build_reply_prompt(task: dict, ctx=None) -> str:
    """Промпт, когда владелец написал по задаче, УЖЕ СДАННОЙ на проверку.

    Заход в этом режиме отвечает и уходит: карточку не забирает и состояние
    не сбивает. Так и задумано на сервере — вернуть сданную работу себе
    агент не может, это дверь владельца (AGENT-PROTOCOL.md, матрица
    переходов). Раньше такой комментарий просто повисал: будильник видел
    «review» и не брался, а Максим ждал ответа, которого никто не собирался
    давать.
    """
    comments = "\n".join(
        f"  {c.get('user_name')}: {c.get('text')}"
        for c in (task.get("comments") or [])[-5:]
    )
    return f"""По задаче «{task.get('title')}», которую ты сдал на проверку, пришёл комментарий.

Свежее в ленте:
{comments or '  (пусто)'}

Ответь комментарием по задаче ({task.get('id')}) — по существу вопроса,
коротко, тому, кто спрашивает. Просят доработать — скажи, что готов, и
попроси вернуть задачу в работу: сданную карточку агент забрать обратно не
может, это дверь владельца.

Состояние задачи НЕ меняй: она на проверке, и она должна там остаться.
Шаги не трогай. Твоё дело здесь — ответить.
    {_render_ctx(ctx)}
"""


def build_orchestrator_prompt(task: dict, reason: str, is_claude: bool = False, ctx=None) -> str:
    """Промпт для оркестратора — дробит и раздаёт, сам не исполняет.

    Заведено 26.08.2026: build_prompt() выше говорит любому агенту «сделай
    сам», и Оркестратор-Claude, получив её, честно сел искать материал
    руками вместо того чтобы создать дочерние задачи и назначить их —
    владелец поймал это в первом же реальном прогоне. Роль назначается
    флагом agent["role"]=="orchestrator" в EXTERNAL_AGENTS, отдельно от
    build_prompt(), а не веткой внутри неё: смысл писем разный настолько,
    что общий шаблон с условиями читался бы хуже, чем два текста.
    """
    comments = "\n".join(
        f"  {c.get('user_name')}: {c.get('text')}" for c in (task.get("comments") or [])[-8:]
    )
    
    if is_claude:
        return f"""Тебя разбудила доска TaskFlow: {reason}.

    Ты находишься в своей рабочей tmux-сессии. Напоминаю: ты не просто бот-распределитель, ты — старший разработчик с гигантской историей работы над этим проектом. У тебя есть твоя память (`memory.md`), системные правила (`CLAUDE.md`) и мощный семантический поиск по кодовой базе. Обязательно применяй этот опыт, не тащи его как мёртвый груз!

    Сейчас от тебя требуется выступить в роли Оркестратора. Твоя задача — не писать код руками, а грамотно спроектировать решение на базе своего опыта и раздать куски работы команде агентов через MCP-инструменты.

    ЗАДАЧА #{task.get('id')}
    Название: {task.get('title')}
    Описание:
    {task.get('description') or '(пусто)'}

    Лента (последние комментарии):
    {comments or '  (пусто)'}

ВАЖНО: Вся должностная инструкция о том, КАК именно работать с TaskFlow (как бить задачи, как использовать `parent_id`, кто есть кто в команде и как принимать работу), лежит в файле `docs/taskflow-orchestrator.md`. 
Если ты забыл регламент — обязательно прочитай этот файл перед тем, как действовать!
    {_render_ctx(ctx)}
"""

    return f"""Тебя разбудила доска TaskFlow: {reason}.

От тебя требуется выступить в роли Оркестратора. Твоя задача — не писать
код руками, а раздать работу команде через MCP-инструменты (taskflow_*).

ЗАДАЧА #{task.get('id')}
Название: {task.get('title')}
Описание:
{task.get('description') or '(пусто)'}

Лента (последние комментарии):
{comments or '  (пусто)'}

Действуй по шагам:
1. Разбери ТЗ на мелкие задачи, которые можно раздать разным агентам.
   Один шаг — один исполнитель. Шаги должны быть короткими, чтобы работа
   не висела сутками без проверки.
2. Создай проект (taskflow_create_project) под эту координацию. Его
   название — суть того, что делаем, без привязки к id. В его заметку
   (notes) сразу сложи справочную информацию: архитектурные решения, где
   найти нужные файлы, какие библиотеки использовать — то, что агентам
   придётся искать самим, если ты им этого не дашь.
2.5. Вызови taskflow_doc_read и прочитай ДОКУМЕНТАЦИЮ И ТЕКУЩИЕ СТАТУСЫ. Это крайне важно!
3. Развесь дочерние задачи (taskflow_create_task). ВАЖНО:
   - В description каждой КАПСОМ укажи: "ПОМНИ, ЧТО ТЫ РАБОТАЕШЬ В РАМКАХ ПРОЕКТА <id проекта из шага 2> — ВСЕ ЗАМЕТКИ, ДОКИ И ОБЩИЕ ДОГОВОРЕННОСТИ ЧИТАЙ И ПИШИ ТУДА".
   - parent_id ОБЯЗАТЕЛЕН (id этой задачи #{task.get('id')}).
   - Исполнитель (assignee_id) ОБЯЗАТЕЛЕН — раздай работу агентам u2, u3 (в зависимости от роли). Если не знаешь кому — назначай всем поровну. Не оставляй пустых!
   - Не запрашивай рефакторинг "вокруг" изменённого. Строго по ТЗ. Правило:
     улучшению по инициативе исполнителя, даже если рядом окажется
     несовершенный код. Владелец 27.08.2026: не ломать соседнее рабочее
     ради того, что «раз уж я здесь».
4. taskflow_comment(id=этой задачи, text=...) — перечисли, кому что
   поручено и почему, и ОБЯЗАТЕЛЬНО назови id созданного проекта. Это твой
   единственный источник правды при следующем пробуждении, пиши подробно:
   без записанного id ты на следующем заходе не найдёшь, где идёт работа.
5. НЕ переводи эту задачу в review и не закрывай её. Она остаётся
   in_progress, пока дети не закрыты — заход заканчивается на шаге 4.

Если тебя разбудили ПОВТОРНО по этой же задаче (в ленте уже есть твой
комментарий с распределением) — не создавай задачи заново. Вместо этого:
taskflow_project_tasks(project_id=<id проекта>) — посмотри на статус
дочерних задач. Кто-то в review — оцени результат по комментарию,
прокомментируй принятие или верни на доработку (taskflow_state с
comment). Кто-то в blocked по причине, которую можешь снять сам —
сними. Все дети закрыты/приняты — подведи итог одним комментарием на
этой задаче и переведи ЕЁ в review — это владельцу сигнал, что вся
координация закончена.

ИТОГ РАБОТЫ КЛАДЁТСЯ В ДОКУМЕНТАЦИЮ ПРОЕКТА, А НЕ ТОЛЬКО В ЛЕНТУ.
Перед тем как перевести задачу в review, вызови taskflow_doc_write
(project_id=<id проекта из шага 2.5>) и сложи туда результат — то, ради чего работа
затевалась: сам материал, выводы, ссылки на первоисточники, что при
приёмке отбраковано и почему. Отдельной заметкой — разбор захода: что
сработало, где ошиблись, что учесть в следующий раз. Комментарий в ленте
живёт внутри карточки и теряется вместе с ней; документация проекта
остаётся и читается владельцем как справочник. Пиши по-человечески и
по-русски: это документ для чтения, а не выгрузка твоих действий.

Стоп-линия: прод, удаление данных, деньги, действия наружу — не делай
сам, опиши в комментарии и уйди в blocked.
    {_render_ctx(ctx)}
"""


def build_orchestrator_resume_prompt(task: dict, reason: str, is_claude: bool = False, ctx=None) -> str:
    """Продолжение СВОЕЙ ЖЕ сессии оркестратора.

    Отдельный текст, а не build_resume_prompt: тот исполнительский — он
    велит закрывать шаги и сдавать задачу самому, что для оркестратора
    прямо противоположно роли. Здесь только повод и свежая лента: кого он
    назначил, какой завёл проект и что уже принято, сессия помнит сама —
    ради этого она и продолжается.
    """
    comments = "\n".join(
        f"  {c.get('user_name')}: {c.get('text')}"
        for c in (task.get("comments") or [])[-5:]
    )

    if is_claude:
        return f"""Доска TaskFlow снова зовёт по координационной задаче «{task.get('title')}»: {reason}.

Ты всё в той же tmux-сессии. Твоя память, контекст проекта и инструменты — при тебе.
Это та же задача, которую ты уже раздавал. Кому что поручено и в каком проекте идёт работа, ты помнишь (либо можешь быстро посмотреть в базе).
Заново не разбирай и не создавай дочерние задачи повторно.

Свежее в ленте:
{comments or '  (пусто)'}

Напоминаю: регламент Оркестратора лежит в `docs/taskflow-orchestrator.md`.
Проверь статусы дочерних задач. Используй свой сеньорский опыт, чтобы оценить сданный агентами результат. 
Прими работу, помоги с блокером или заверни на доработку.
    {_render_ctx(ctx)}
"""

    return f"""Доска TaskFlow снова зовёт по координационной задаче «{task.get('title')}»: {reason}.

Это та же задача, которую ты уже раздавал в этой сессии — кому что поручено
и в каком проекте идёт работа, ты помнишь. Заново не разбирай и не создавай
дочерние задачи повторно.

Свежее в ленте:
{comments or '  (пусто)'}

Посмотри статус детей (taskflow_project_tasks по своему проекту) и сделай
ровно то, что нужно сейчас: принять сданное, вернуть на доработку, снять
чужой blocked, если это в твоих силах. Все дети закрыты — сложи итог в
документацию проекта (taskflow_doc_write) и переведи ЭТУ задачу в review.
Не закончено — оставь её in_progress и заканчивай заход комментарием о том,
чего ждёшь.

Сам работу не исполняй: ты по-прежнему оркестратор.
    {_render_ctx(ctx)}
"""


def build_prompt(task: dict, reason: str, ctx=None, include_role_prompt: bool = True) -> str:
    subtasks = task.get("subtasks") or []
    steps = "\n".join(
        f"  {'[x]' if s.get('done') else '[ ]'} {s.get('title')}" for s in subtasks
    )
    comments = "\n".join(
        f"  {c.get('user_name')}: {c.get('text')}" for c in (task.get("comments") or [])[-8:]
    )
    role_prompt = role_prompt_for_task(task) if include_role_prompt else ""
    return f"""Тебя разбудила доска TaskFlow: {reason}.

ЗАДАЧА #{task.get('id')}
Название: {task.get('title')}
Описание:
{task.get('description') or '(пусто)'}

{f'СИСТЕМНЫЙ ПРОМПТ РОЛИ {task_role(task)}:\n{role_prompt}\nКОНЕЦ СИСТЕМНОГО ПРОМПТА РОЛИ' if role_prompt else ''}

Шаги:
{steps or '  (нет)'}

Лента (последние комментарии):
{comments or '  (пусто)'}

КАК РАБОТАТЬ (конвейер снизу вверх, AGENT-PROTOCOL.md проекта ~/Проекты/New-Todoist,
кратко — скилл taskflow-work): задачу уже взяли в работу за тебя (claim сделан
службой), аренду тоже продлевает служба — heartbeat слать не нужно. У тебя
подключён MCP-сервер taskflow — работай его инструментами, не сырым API.

⛔ ШАГ ЗАКРЫВАЕТСЯ ТОЛЬКО ПОСЛЕ РЕАЛЬНОЙ РАБОТЫ. «Я понял, что надо
   сделать», «это небольшая серверная часть», «осталось добавить роут» —
   это НЕ выполненный шаг, а план. Ничего не изменил в файлах и не проверил
   результат — шаг не закрывай и задачу на приёмку не сдавай. Не получается
   или непонятно — честный blocked с объяснением; он стоит дешевле, чем
   выдуманный отчёт, по которому владелец решит, что работа сделана.
   Прецедент 29.08.2026: исполнитель закрыл три шага за две минуты и
   отчитался «готово», не тронув НИ ОДНОГО файла — проверка показала ноль
   правок в проекте, карточка вернулась на доработку.

- ПЕРЕД тем как коснуться шага — taskflow_subtask_work(state="in_progress").
  Это включает анимацию у шага в ленте — Максим должен видеть, какой шаг идёт.
- Сделал шаг → закрывай сам: taskflow_subtask_done(result="…") — одно-два
  предложения по-человечески, что было и что стало, без жаргона. В result
  должно быть видно, ЧТО ИМЕННО изменилось: какой файл, какая команда, какой
  результат проверки. Пустой или общий result — признак невыполненной работы. Сдавать на
  приёмку не нужно — с 20.08.2026 галочку ставит и агент. review остаётся
  добровольной опцией (taskflow_subtask_work(state="review", result="…")),
  если работу стоит показать до закрытия, — не обязательный шаг конвейера.
- Упёрся на шаге → taskflow_subtask_work(state="blocked", result="…") —
  конкретно, что мешает и какого решения ждёшь ОТ МАКСИМА. Ждёшь ответа от
  другого агента/сессии (не от Максима) — это не blocked, оставайся
  in_progress и продолжай остальные шаги; blocked означает «встал, нужен
  владелец», а не «жду коллегу».
- Все шаги сделаны (или шагов не было) → закрывай саму задачу сам:
  taskflow_state(completed) — с 20.08.2026 доступно и агенту, приёмка
  владельцем отменена. Не можешь продолжить вообще → taskflow_state(blocked,
  comment="…"). Никогда не оставляй задачу в in_progress, уходя.
- ДОКУМЕНТАЦИЯ ПРОЕКТА — ЧИТАЙ ДО, ПИШИ ПОСЛЕ (владелец 29.08.2026: «зачем
  нам заново что-то изучать, когда есть текущий контекст, который нужно
  просто красиво оформить и вложить»). ДО работы: taskflow_docs(project_id=…)
  и taskflow_doc_read по подходящей заметке — там уже может лежать ответ,
  как устроена эта часть и что про неё выяснили раньше. ПОСЛЕ: если добавил
  возможность или изменил устройство чего-то (не отладка и не мелкая
  правка) — taskflow_doc_write в тот же проект: что изменилось, как теперь
  работает, чего не делать. Пиши человеческим языком, это документ для
  чтения, а не выгрузка твоих действий. Владелец читает документацию
  проекта с телефона; заметка в репозитории или в базе знаний ему не видна.
  ⚠️ НЕ ЗАВОДИ ПАПКУ ПОД СВОЁ ЗАДАНИЕ и не создавай заметку-отчёт «как я
  поработал» (владелец 29.08.2026: «папки в папках по заданию — глупость, я
  даже не пойму, к чему их отнести»). Пиши В СУЩЕСТВУЮЩИЕ смысловые
  заметки проекта: особенности и грабли, архитектура, основные компоненты.
  Подходящей нет — заводи ОДНУ с понятным названием по смыслу, а не по
  своей задаче.
- НАШЁЛ ПОБОЧНУЮ ПРОБЛЕМУ — В ЗАМЕТКУ «Баги и хвосты» этого проекта, одной
  строкой с датой: что не так и где видно. Карточку под неё СРАЗУ НЕ ЗАВОДИ
  (владелец 29.08.2026: «лучше накопить пул, а потом грамотно раскидать»).
  Решённое там зачёркивают, а не удаляют. Находка, оставленная только в
  ленте своей карточки, теряется вместе с ней: 21.08.2026 диагноз бага
  пролежал неделю в комментарии, и 28.08 ту же причину искали заново.
- СДАЛ ИЛИ УПЁРСЯ — СКАЖИ ОРКЕСТРАТОРУ В ЧАТ, одной строкой:
  taskflow_chat_send(to="Оркестратор Claude", task_id=<id задачи>,
  kind="совещание", text="сдал: <что сделано> / упёрся: <что мешает>").
  Указание задачи обязательно — без него сообщение ложится в общую ленту и
  никого не будит, а с ним оркестратор просыпается сразу и принимает работу.
  Иначе он узнаёт о готовности случайно и с задержкой: своего обхода доски
  у него нет, и карточка может пролежать сданной часами (владелец
  29.08.2026: «пусть они тебе просто скажут, и никаких будильников не надо»).
- Стоп-линия: прод, удаление данных, деньги, действия наружу — не делай
  сам, опиши в комментарии и уйди в blocked.
- Инструментов taskflow_* нет в списке (MCP не переподключился) → не городи
  обход сырым curl, сразу уйди в blocked с этой же причиной — тебя спросить
  некому, ты один.
    {_render_ctx(ctx)}
"""


# Сколько заходов подряд служба делает по одной задаче и сколько ждёт между
# ними. Предел нужен не «на всякий случай»: заход это расход у провайдера
# агента, и агент, застрявший на одном шаге, будет жечь его молча.
# Владелец 29.08.2026, прямым текстом: «я был согласен на один заход на
# одну задачу… мы, блядь, сделали на один шаг десять заходов». Цепочка
# из восьми заходов задумывалась как «дай агенту доделать», а на деле
# крутилась вхолостую: движением считался комментарий самой службы
# (починено в activity_mark), и каждый круг жёг чужой лимит. Не доделал
# за заход — карточка остаётся на доске, и его позовут снова по
# событию или обходом; это дешевле, чем восемь кругов подряд.
MAX_RUNS = 1
# Оркестратору столько заходов подряд не нужно, а стоят они столько же.
# 26.08.2026: пять заходов подряд, каждый заканчивался тем, что смотреть не
# на что — дети ещё работают. Движением при этом считался его собственный
# комментарий (см. activity_mark), поэтому цепочка не гасла сама. Его работа
# по природе прерывистая: раздал — ушёл, вернулся, когда ребёнок сдался.
# Разбудит его событие с доски, а не следующий круг в той же цепочке.
MAX_RUNS_ORCHESTRATOR = 2
RUN_GAP_SEC = 10


# Сторож тишины ВНУТРИ хода. Аренда теперь продлевается, пока жив процесс,
# и поэтому больше не ловит зависший ход: процесс дышит, а работа стоит.
# Отличаем одно от другого движением на карточке — закрытые шаги и
# комментарии. Пороги подобраны под живые заходы: 20 минут тишины бывают у
# крупного шага, 45 — это уже не работа.
SILENT_WARN_MIN = 20
SILENT_KILL_MIN = 45

# Хвост вывода агента, по которому видно, что он не работал, а отказал:
# так о себе говорит его собственный CLI, когда не может пойти к модели
# (нет провайдера, отвергнут ключ, кончился лимит).
FAILURE_MARKS = ("agent failed", "no llm provider", "rate limit",
                 "quota exceeded", "insufficient", "unauthorized")


def closed_steps(task_id: str) -> int:
    """Сколько шагов задачи закрыто — мерка продвижения между заходами."""
    task = api("GET", f"/api/tasks/{task_id}") or {}
    subs = task.get("subtasks") or []
    return sum(1 for s in subs if s.get("done"))


# Репозитории, в которых работают агенты. Правка файлов — такое же
# движение, как отметка на доске, и куда более частое: агент может целый
# заход писать код внутри одного шага.
REPOS = [
    HOME / "Проекты" / "AI-Control-Center",
    HOME / "Проекты" / "New-Todoist",
]


def worktree_mark() -> tuple:
    """Отпечаток рабочего дерева: последний коммит и состояние правок.

    ⚠️ Без этого мерка движения врала. Прецедент 21.08.2026: Гермес целый
    заход писал экран настроек (новый файл, правки в трёх соседних), но не
    успел закоммитить и закрыть шаг — доска молчала, и служба дважды
    ошиблась: сторож объявил тишину, а цепочка встала с «не сдвинул ни
    одного шага». Работа при этом шла.
    """
    marks = []
    for repo in REPOS:
        try:
            head = subprocess.run(
                ["git", "-C", str(repo), "rev-parse", "HEAD"],
                capture_output=True, text=True, timeout=5,
            ).stdout.strip()
            dirty = subprocess.run(
                ["git", "-C", str(repo), "status", "--porcelain"],
                capture_output=True, text=True, timeout=15,
            ).stdout
            marks.append((head, hashlib.md5(dirty.encode()).hexdigest()))
        except Exception:  # репозитория нет или git занят — не мерка, но и не сбой
            marks.append(("", ""))
    return tuple(marks)


def activity_mark(task_id: str) -> tuple:
    """Отпечаток движения: доска плюс рабочее дерево.

    Меняется на любое осмысленное действие агента — закрытый шаг, отметку
    начала, комментарий, правку файла, коммит. Аренда для этого не годится:
    её шлём мы сами, и она горит даже у зависшего хода.
    """
    subs = api("GET", f"/api/tasks/{task_id}/subtasks") or []
    comments = api("GET", f"/api/tasks/{task_id}/comments") or []
    closed = sum(1 for s in subs if s.get("done"))
    working = sum(1 for s in subs if s.get("agent_state") == "in_progress")
    # ⚠️ СЧИТАЕМ ТОЛЬКО ЧУЖИЕ КОММЕНТАРИИ, НЕ СВОИ СЛУЖЕБНЫЕ. Служба сама
    # пишет в карточку после каждого захода («Заход выполнен на модели…»,
    # «Расход захода…»), а раньше здесь считались ВСЕ комментарии подряд —
    # и собственная запись выглядела движением агента. Итог: заход, в
    # котором агент не сделал ничего, всё равно считался результативным, и
    # цепочка крутилась до предела в 8 заходов, сжигая чужой лимит впустую.
    # Поймано 29.08.2026, владелец: «за каждый заход мы палим лимиты, при
    # этом результата не имеем никакого». Та же болезнь уже лечилась
    # точечно у оркестратора (MAX_RUNS_ORCHESTRATOR), но корень оставался.
    #
    # Служебные записи узнаём по автору: их пишет учётка, под которой
    # работает сама служба, а не исполнитель задачи.
    own = sum(1 for c in comments
              if (c.get("user_id") or "") not in SERVICE_AUTHORS)
    children = api("GET", f"/api/tasks?parent_id={task_id}&include_children=true") or []
    ch_list = children if isinstance(children, list) else (children.get("tasks", []) if isinstance(children, dict) else [])
    children_marks = tuple((c.get("id"), c.get("status"), c.get("agent_state")) for c in ch_list)
    return (closed, working, own, children_marks, worktree_mark())


def set_state(task_id: str, state: str, comment: str, token: str = "") -> None:
    """Состояние работы по задаче — от имени того, за кого мы её ведём."""
    api("POST", f"/api/tasks/{task_id}/state",
        {"state": state, "comment": comment}, token=token)


def silence_watch(task_id: str, proc_box: dict, stop: threading.Event,
                  agent_name: str) -> None:
    """Смотрит, движется ли работа, пока идёт ход, и вмешивается по порогам.

    Предупреждение — комментарием в карточку: владелец видит «идёт долго
    без движения» и решает сам. Снятие — только на втором пороге и с
    объяснением: висящий ход держит задачу и жжёт расход у провайдера
    агента, а сказать об этом некому, кроме нас.
    """
    last = activity_mark(task_id)
    since = time.time()
    warned = False
    while not stop.wait(60):
        now = activity_mark(task_id)
        if now != last:
            last, since, warned = now, time.time(), False
            continue
        idle_min = (time.time() - since) / 60
        if idle_min >= SILENT_KILL_MIN:
            proc = proc_box.get("proc")
            log(f"  ⛔ «{agent_name}»: {int(idle_min)} мин без движения — снимаю ход")
            set_state(task_id, "blocked",
                      f"Будильник снял ход: {int(idle_min)} минут ни одного "
                      f"движения по задаче — ни закрытого шага, ни комментария. "
                      f"Процесс был жив, но работа стояла. Что делать дальше — "
                      f"решай ты: перезапустить или разобраться, на чём он встал.")
            if proc and proc.returncode is None:
                proc.terminate()
            return
        if idle_min >= SILENT_WARN_MIN and not warned:
            warned = True
            log(f"  ⚠️ «{agent_name}»: {int(idle_min)} мин без движения")
            note(task_id,
                 f"Будильник: «{agent_name}» работает, но {int(idle_min)} минут "
                 f"не было ни одного движения по задаче. Пока не трогаю — если "
                 f"тишина продлится до {SILENT_KILL_MIN} минут, ход сниму.")


def note(task_id: str, text: str, token: str = "") -> None:
    """Записка в карточку от службы — чтобы решение было видно владельцу.

    Токен нужен, когда записка идёт по задаче ЧУЖОГО исполнителя: комментарий
    пишется его учёткой, иначе сервер не пустит — задача не принадлежит
    Claude_Bot, чьим ключом служба ходит по умолчанию. Пусто — общий ключ.
    """
    api("POST", f"/api/tasks/{task_id}/comments", {"text": text}, token=token)


def should_continue(task_id: str, before: tuple) -> tuple[bool, str]:
    """Звать ли агента снова после того, как он завершил заход.

    Три причины НЕ звать, и все они честные состояния, а не догадки:
    агент сам сказал «жду владельца» (blocked) или сдал работу
    (review/completed); все шаги закрыты; заход не сдвинул ни одного шага —
    значит агент топчется, и следующий заход, скорее всего, потратит расход
    впустую.
    """
    task = api("GET", f"/api/tasks/{task_id}")
    if not task:
        return False, "задачу больше не видно"
    state = task.get("agent_state")
    if state in ("blocked", "review", "completed"):
        return False, f"агент сам поставил «{state}»"
    if task.get("status") != "active":
        return False, "задача больше не активна"
    subs = task.get("subtasks") or []
    if subs and all(s.get("done") for s in subs):
        return False, "все шаги закрыты"
    # Движение меряем полным отпечатком — доска И рабочее дерево. По одним
    # закрытым шагам мерить нельзя: заход целиком уходит внутрь одного
    # крупного шага, и работа видна только в файлах (см. worktree_mark).
    if activity_mark(task_id) == before:
        return False, "заход не оставил следов — ни на доске, ни в файлах"
    return True, ""


def heartbeat_loop(task_id: str, stop: threading.Event, token: str = "") -> None:
    """Сигнал «работа идёт», пока жив запущенный нами процесс.

    token — ключ ТОГО агента, за которого держим аренду: сервер продлевает
    её только владельцу аренды, чужим ключом сигнал не считается.
    """
    while not stop.wait(HEARTBEAT_SEC):
        api("POST", f"/api/tasks/{task_id}/heartbeat", {}, token=token)


def heartbeat_until_done(task_id: str, stop: threading.Event, token: str = "") -> None:
    """Heartbeat пока карточка числится за этим исполнителем и в работе.

    Отличие от heartbeat_loop, который опирается на stop из запускающего
    потока: здесь остановка по СОСТОЯНИЮ карточки.
    service), и «пока жив запущенный нами процесс» там равен «пока жива
    служба», то есть всегда. Без самостопа heartbeat ходил бы в карточку,
    уже сданную на проверку или закрытую владельцем — UPDATE молча отдаёт
    ноль строк, вреда нет, но и смысла тоже (карточка 5de557a5, 28.08.2026).

    token — ключ исполнителя, как у heartbeat_loop. Если карточку
    переназначили на другого, сервер вернёт 400 на heartbeat — пустая
    трата тика, но не ошибка: всё, что мы хотим от этой ветки, это
    доказать «я здесь», а не валидировать владельца аренды.
    """
    while not stop.wait(HEARTBEAT_SEC):
        fresh = get_task(task_id)
        if not fresh:
            return
        if fresh.get("agent_state") != "in_progress":
            return
        api("POST", f"/api/tasks/{task_id}/heartbeat", {}, token=token)


def stop_when_card_leaves(task_id: str, stop: threading.Event) -> None:
    """Сторож для heartbeat_until_done: выставить stop, как только карточка
    перестала быть «у этого исполнителя в работе».

    Спит дольше HEARTBEAT_SEC (вдвое — с запасом на пропущенный тик) и
    смотрит ровно то, что смотрит heartbeat_until_done: без догадок по
    событиям, без подписки на WS. Дешевле и достаточнее: карточка редко
    меняет состояние чаще, чем раз в минуту.
    """
    while not stop.wait(HEARTBEAT_SEC * 2):
        fresh = get_task(task_id)
        if not fresh:
            stop.set()
            return
        if fresh.get("agent_state") != "in_progress":
            stop.set()
            return


def read_usage(path: str) -> str:
    """Человеческая строка о расходе захода или пустая, если отчёта нет.

    Формат снят с живого отчёта Гермеса 27.08.2026: estimated_cost_usd,
    input_tokens, output_tokens, total_tokens, api_calls, model, provider,
    cost_status. Читаем мягко — чего нет, того не показываем, а не падаем.
    Файл после чтения убираем: это мусор на один заход, не архив.

    ⚠️ Деньги показываем ТОЛЬКО когда агент их реально посчитал. По подписке
    он ставит estimated_cost_usd = 0.0 и cost_status = "unknown" — напечатать
    оттуда «$0.00» значит соврать владельцу, что заход бесплатный, тогда как
    он просто не тарифицируется поштучно.
    """
    if not path or not os.path.exists(path):
        return ""
    try:
        with open(path) as f:
            d = json.load(f)
    except Exception:
        return ""
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass

    parts = []
    total = d.get("total_tokens")
    if isinstance(total, (int, float)) and total:
        inp, out = d.get("input_tokens"), d.get("output_tokens")
        if isinstance(inp, (int, float)) and isinstance(out, (int, float)):
            parts.append(f"{int(total)} токенов ({int(inp)} на вход, {int(out)} на ответ)")
        else:
            parts.append(f"{int(total)} токенов")

    cost, status = d.get("estimated_cost_usd"), (d.get("cost_status") or "")
    if isinstance(cost, (int, float)) and cost > 0 and status not in ("unknown", "none"):
        parts.append(f"≈ ${cost:.4f}".rstrip("0").rstrip("."))
    elif status in ("unknown", "none"):
        parts.append("по подписке, поштучно не тарифицируется")

    calls = d.get("api_calls")
    if isinstance(calls, (int, float)) and calls:
        parts.append(f"обращений к модели: {int(calls)}")
    model, provider = d.get("model"), d.get("provider")
    if model:
        parts.append(f"модель {model}" + (f" ({provider})" if provider else ""))
    return ", ".join(parts)


# ── Единая доставка поручений (agent_inbox) ────────────────────────────────
# Карточка 5f292e87, повторное ревью 07.09.2026: служба обязана свериться с
# inbox ДО claim и запуска процесса. Устаревшее событие (версия карточки
# уехала вперёд после возврата из review) должно тихо отбрасываться ЗДЕСЬ —
# раньше оно отбрасывалось только при mark, когда процесс уже мог пойти.
# Матрица переходов — одна на сервер и службу: agent_inbox.ALLOWED_NEXT.


def inbox_consume(task_id: str, token: str) -> tuple[list[dict], bool]:
    """Принять свои непринятые события по карточке (sent → received).

    Возвращает (принятые события, ок). ок=False — запуск отменяется:
    событие устарело (сервер сам пометил его blocked) либо уже разобрано
    другим процессом (повторная доставка не должна давать второй запуск).
    Событий по карточке нет вовсе — ок=True: комментарий владельца или
    будильник по старым путям не обязаны иметь inbox-событие.
    """
    resp = api("GET", "/api/agent-inbox/pending", token=token)
    if resp is None:
        # Проверка доставки обязательна: без неё возможен запуск по
        # устаревшему поручению. Отменяем заход — как и при недоступности
        # основной карточки (Шаг 6 ТЗ taskflow-direct-dispatch-mvp).
        log("  inbox: pending недоступен — запуск отменяю")
        return [], False
    events = [it for it in resp.get("items", []) if it.get("task_id") == task_id]
    taken: list[dict] = []
    for ev in events:
        marked = api("POST", f"/api/agent-inbox/{ev['id']}/mark",
                     {"status": "received"}, token=token)
        if marked is None or marked.get("dropped"):
            # None — 409 (событие уже разобрано соседним процессом) или
            # сеть; dropped — устаревшая версия карточки, сервер сам
            # пометил событие blocked и записал причину в журнал.
            log(f"  inbox: событие {str(ev.get('id'))[:8]} не принято "
                f"(устарело или уже разобрано) — запуск отменяю")
            return taken, False
        taken.append(ev)
    return taken, True


def inbox_mark(events: list[dict], status: str, token: str, reason: str = "") -> None:
    """Мягкая пометка принятых событий (acting/done/blocked). Сбой записи в
    журнал доставки не должен ронять запуск: это телеметрия, а не страж."""
    for ev in events:
        body: dict = {"status": status}
        if reason:
            body["blocked_reason"] = reason
        api("POST", f"/api/agent-inbox/{ev['id']}/mark", body, token=token)


def run_external(task: dict, reason: str, agent: dict) -> None:
    """Позвать не-Claude агента одним разовым запросом.

    У Гермеса и dsh нет продолжаемой сессии: каждый заход самостоятелен,
    поэтому им отдаётся тот же вводный текст, что и Клоду при первом
    заходе (build_prompt) — там и правила конвейера, и что за задача.

    Аренду держим ПОКА ЖИВ ЕГО ПРОЦЕСС, его же ключом.

    ⚠️ Раньше её не держали вовсе — считалось, что хватит продления на
    каждое действие агента по задаче (комментарий, закрытие шага). Не
    хватило: 21.08.2026 Гермес взял задачу по большому ТЗ, отметил первый
    шаг и ушёл читать задание и писать код. Через пять минут молчания доска
    показала «брошена», хотя процесс работал, — владелец увидел ровно то же,
    что и в прошлый раз: «что-то он пропал». Длинный шаг — это норма, а не
    признак пропажи, и отличить работающего агента от исчезнувшего может
    только тот, кто его запустил.
    """
    task_id = task["id"]
    assignee_id = task.get("assignee_id") or ""
    with LOCK:
        if task_id in RUNNING:
            log(f"  задача {task_id[:8]} уже выполняется — пропускаю")
            return
        RUNNING[task_id] = (None, assignee_id)

    if os.environ.get("TASKFLOW_TRIGGER_DRY") == "1":
        log(f"[сухой прогон] позвал бы «{agent['name']}» на «{task.get('title')}» ({reason})")
        with LOCK:
            RUNNING.pop(task_id, None)
        return

    token = agent.get("token") or ""
    reply_only = reason == REPLY_ONLY

    # Единая доставка: свериться с inbox ДО контекста, claim и запуска
    # процесса (см. inbox_consume). В режиме ответа карточка не забирается —
    # там брать нечего, гейт не нужен.
    inbox_events: list[dict] = []
    if not reply_only:
        inbox_events, gate_ok = inbox_consume(task_id, token)
        if not gate_ok:
            with LOCK:
                RUNNING.pop(task_id, None)
            return

    # Шаг 4 ТЗ docs/taskflow-direct-dispatch-mvp.md — собрать TaskContext v1
    # перед запуском. mode/parent_task_id различают прямого исполнителя и
    # оркестратора. TaskEnricher обязателен — если он упал, запуск НЕ
    # происходит (Шаг 6 ТЗ: «Недоступен основной API-запрос карточки —
    # процесс не стартует; ошибка записана в лог»). Knowledge/Repository —
    # мягкие, падают в status=unavailable.
    is_orch = agent.get("role") == "orchestrator"
    # Шаг 4 ТЗ: для оркестратора parent_id — id карточки, на которую он
    # НАЗНАЧЕН (т.е. родительской для своих дочерних). task.parent_id у
    # неё самой пустой (это корень), а нужен её собственный id.
    parent_id = task.get("id") if is_orch else None
    try:
        from task_context import build_context as _bc, _load_projects_config
        ctx = _bc(task, agent or {}, _load_projects_config(),
                  mode="coordinated" if is_orch else "direct",
                  parent_task_id=parent_id)
        log(
            f"  контекст подготовлен: schema={ctx.schema_version}, "
            f"knowledge={ctx.knowledge['status']}, "
            f"repository={ctx.repository['status']}, "
            f"warnings={len(ctx.warnings)}"
        )
        # Шаг 6 ТЗ: «в журнал задачи краткий факт со статусами
        # источников, не только в log()». Пишем через note() — это
        # HTTP POST /api/tasks/{id}/comment, идёт в ленту. Мягко:
        # ошибка записи в журнал не должна ронять запуск.
        try:
            note(
                task_id,
                f"контекст подготовлен: knowledge={ctx.knowledge['status']}, "
                f"repository={ctx.repository['status']}, "
                f"warnings={len(ctx.warnings)}",
                token=agent.get("token") or "",
            )
        except Exception as exc:  # noqa: BLE001
            log(f"  ⚠️ не удалось записать факт в журнал задачи: {exc!r}")
    except Exception as exc:  # noqa: BLE001
        log(f"  контекст не собран, запуск отменён: {exc!r}")
        if inbox_events:
            inbox_mark(inbox_events, "blocked", token,
                       f"контекст не собран: {exc!r}")
        with LOCK:
            RUNNING.pop(task_id, None)
        return

    # Взять карточку в работу ЗА него — его же ключом, иначе claim ляжет на
    # учётку службы. Без этого агент работал, а доска показывала «не взята»:
    # владелец смотрит на неё и видит, что ничего не происходит.

    # Агент на Claude CLI (Оркестратор-Claude) возвращается в СВОЮ прошлую
    # сессию по этой задаче — ровно так же, как давно делает путь
    # Claude_Bot. До 28.08.2026 этого здесь не было, и каждый заход
    # оркестратора начинался с чистого листа.
    #
    # ⚠️ Номер читается ДО claim: claim пишет agent_session_id тем, что
    # пришло в теле, без COALESCE. Прежний claim с пустым телом не записывал
    # его вовсе — у задач оркестратора колонка стояла пустой, и возвращаться
    # было некуда, даже когда транскрипт был цел.
    claude_cli = bool(agent.get("claude_cli"))
    resume_sid = new_sid = ""
    fork = False
    if claude_cli:
        resume_sid, new_sid, fork = resume_target(task, token)
    # Номер, в который этот заход БУДЕТ писать: он же уходит на карточку и
    # он же продолжается заходами 2+ внутри цепочки.
    session_sid = new_sid if (not resume_sid or fork) else resume_sid

    if not reply_only:
        claimed = api("POST", f"/api/tasks/{task_id}/claim",
                      {"session_id": session_sid} if claude_cli else {}, token=token)
        if claimed is None and task.get("agent_state") != "in_progress":
            log(f"  не удалось взять задачу {task_id[:8]} за «{agent['name']}» — отменяю заход")
            if inbox_events:
                inbox_mark(inbox_events, "blocked", token,
                           "не удалось взять задачу (claim)")
            with LOCK:
                RUNNING.pop(task_id, None)
            return
        # Событие принято и разобрано этим заходом — журнал доставки видит
        # sent → received (в гейте) → acting (здесь, после claim).
        if inbox_events:
            inbox_mark(inbox_events, "acting", token)
        api("POST", f"/api/tasks/{task_id}/activity",
            {"kind": "run", "target": "анализирует задачу и координирует команду" if "оркестратор" in agent.get("name", "").lower() else "взял задачу в работу"}, token=token)

    # Метка модели. У кого есть model_flag — уходит аргументом; у dsh флага
    # модели не существует вовсе, ему подменяем домашний каталог, в котором
    # лежат его настройки (см. dsh_home_for). Окружение собираем ЗДЕСЬ, на
    # заход: общий agent["env"] один на всех, и правка его на месте увела бы
    # соседнюю задачу на чужую модель.
    model = model_of(task)
    if agent.get("name") == "Antigravity":
        # 29.08.2026: у Antigravity РАБОТАЮТ НЕ ВСЕ его модели. Проверено
        # прогоном по каждой: claude-sonnet-4-6, claude-opus-4-6-thinking и
        # gpt-oss-120b-medium отвечают, а ВСЁ семейство gemini падает с
        # «FAILED_PRECONDITION (400): User location is not supported for the
        # API use» — Google не отдаёт свои модели в наш регион. Ни туннель
        # (проверены Нидерланды и Казахстан), ни свежая авторизация, ни
        # часовой пояс на это не влияют; разбор — в уроке
        # 2026-08-28-antigravity-eligibility-and-stale-mcp.
        #
        # Без метки на задаче флаг --model не передавался вовсе, и CLI шёл
        # на СВОЮ модель по умолчанию — Gemini 3.7 Flash. Отсюда и брались
        # «Agent execution terminated due to error» на каждом заходе: агент
        # был исправен, звали его нерабочей моделью. Поэтому умолчание
        # задаём явно.
        model = ANTIGRAVITY_MODEL_ALIASES.get(
            (model or "").lower(), model or ANTIGRAVITY_DEFAULT_MODEL)
        # Страховка от тихого отказа: метку gemini кто-нибудь поставит и
        # через месяц (их имена остались в таблице выше — вдруг регион
        # откроют). Пока не открыли, такой заход умрёт с невнятным «agent
        # execution terminated», и разбираться будут заново. Лучше увести
        # на рабочую модель и СКАЗАТЬ об этом в журнал.
        if model.startswith("gemini"):
            log(f"  ⚠️ модель «{model}» у Antigravity не отвечает в нашем "
                f"регионе — иду на {ANTIGRAVITY_DEFAULT_MODEL}")
            model = ANTIGRAVITY_DEFAULT_MODEL
    run_env = {**os.environ, **agent.get("env", {})}
    # Учётка для всего, что агент поднимет внутри захода — MCP-плагин taskflow,
    # хуки, гейт продления аренды. Без этого (найдено 28.08.2026 на Claude_Bot)
    # хуки taskflow-* ходили на сервер зашитым ключом Claude_Bot: гейт
    # спрашивал «можно ли мне закончить» от чужого имени, а собственная аренда
    # оркестратора никем не продлевалась и честно протухала — владелец видел
    # «агент пропал».
    #
    # Раньше блок был под `if claude_cli:` — это работало, пока оркестратор
    # ходил через Claude Code CLI. После перевода оркестратора на dsh
    # (`claude_cli: False` в EXTERNAL_AGENTS) условие перестало срабатывать
    # для самого главного потребителя — оркестратора, и его dsh-заходы шли без
    # MCP-ключа, отсюда «не оставив следов» в логе (29.08.2026).
    #
    # Берём ИМЯ переменной (vault_key/token_env), потом через os.environ
    # получаем её ЗНАЧЕНИЕ — именно значение systemd через vault-run уже
    # подставил в ENV процесса trigger.py.
    vault_name = agent.get("vault_key") or agent.get("token_env", "")
    vault_value = os.environ.get(vault_name, "") if vault_name else ""
    if vault_value:
        # Дочерний Pi и его MCP получают тот же единственный ключ напрямую.
        # Раньше сюда ошибочно записывалось значение ключа как имя записи
        # хранилища, после чего MCP пытался найти в vault сам токен.
        run_env["TASKFLOW_VAULT_KEY"] = vault_name
        run_env["TASKFLOW_TOKEN"] = vault_value
    dsh_home = ""
    if model and agent.get("name") == "DeepSeek Harness":
        dsh_home = dsh_home_for(model)
        if dsh_home:
            run_env["DSH_HOME"] = dsh_home
    prefix = list(agent["cmd"])
    role = task_role(task)
    if agent.get("name") == "Pi Agent" and role:
        profile = pi_mcp_profile_for_role(role)
        # Pi receives the role profile only through this explicit flag. A
        # regular `pi` command without --mcp-config keeps the normal setup.
        skills = pi_skill_paths_for_role(role)
        prefix = [PI_BIN, "--mcp-config", str(profile)]
        for skill in skills:
            prefix.extend(["--skill", str(skill)])
        prefix.append("-p")
        log(
            f"  Pi: роль {role} → MCP-профиль {profile.name}; "
            f"skills={len(skills)}"
        )
    role_prompt = role_prompt_for_task(task)
    if claude_cli and role_prompt:
        # Claude Code умеет отделить роль от поручения настоящим системным
        # параметром. Для остальных оболочек этот же текст добавляется в
        # стартовый prompt ниже: их CLI не имеет общего system-prompt flag.
        prefix = prefix[:-1] + ["--append-system-prompt", role_prompt, prefix[-1]]
    # Отчёт о расходе: агент сам пишет JSON с оценкой стоимости, числом
    # токенов, моделью и количеством обращений к провайдеру — и пишет даже
    # когда заход упал. Владелец 27.08.2026: «токены расход показывать
    # обязательно». Файл на заход свой, читается сразу после и удаляется.
    usage_path = ""
    if agent.get("usage_flag"):
        usage_path = str(STATE_DIR / f"usage-{task_id[:8]}-{int(time.time())}.json")
        prefix = prefix[:-1] + [agent["usage_flag"], usage_path, prefix[-1]]
    flag = agent.get("model_flag")
    if model and flag:
        # Флаг разового запроса («-z», «--profile headless») идёт последним и
        # забирает следующий аргумент как задание — модель вставляем ПЕРЕД
        # ним, иначе она уедет в текст задачи.
        prefix = prefix[:-1] + [flag, model, prefix[-1]]
    orchestrator = agent.get("role") == "orchestrator"

    def make_cmd(text: str, session: list[str]) -> list[str]:
        """Команда захода. Сессионные флаги идут ПЕРЕД флагом разового
        запроса («-p», «-z»): тот забирает следующий аргумент как задание,
        и всё, что встанет после него, уедет в текст задачи."""
        if not session:
            return prefix + [text]
        return prefix[:-1] + session + [prefix[-1], text]

    def resume_text(fresh: dict) -> str:
        """Письмо на продолжение своей же сессии. У оркестратора своё: общее
        велит закрывать шаги и сдавать задачу, а он раздаёт, а не исполняет."""
        return (build_orchestrator_resume_prompt(fresh, reason, claude_cli, ctx=ctx) if orchestrator
                else build_resume_prompt(fresh, reason, ctx=ctx))

    if reply_only:
        first = build_reply_prompt(task, ctx=ctx)
    elif resume_sid:
        first = resume_text(task)
    elif orchestrator:
        first = build_orchestrator_prompt(task, reason, claude_cli, ctx=ctx)
    else:
        first = build_prompt(task, reason, ctx=ctx, include_role_prompt=False)
    if role_prompt and not claude_cli:
        first = (
            f"{first}\n\nСИСТЕМНЫЙ ПРОМПТ РОЛИ {task_role(task)}:\n"
            f"{role_prompt}\nКОНЕЦ СИСТЕМНОГО ПРОМПТА РОЛИ"
        )
    cmd = make_cmd(first, claude_session_args(resume_sid, new_sid, fork)
                   if claude_cli else [])
    if resume_sid and not fork:
        log(f"  продолжаю сессию {resume_sid[:8]} — контекст на месте")
    log(f"  зову «{agent['name']}» на задачу {task_id[:8]}"
        + (f", модель {model}" if model and (flag or dsh_home) else ""))
    stop = threading.Event()
    # Аренду держим только когда карточка реально взята. В режиме ответа
    # задача остаётся на проверке у владельца — продлевать там нечего.
    if not reply_only:
        threading.Thread(
            target=heartbeat_loop, args=(task_id, stop, token), daemon=True
        ).start()
    try:
        # ЦЕПОЧКА ЗАХОДОВ. Решение владельца 21.08.2026: «когда он сам
        # закончит, пусть выходит, а служба перезапустит».
        #
        # Почему так, а не «пусть работает до конца»: у Гермеса и dsh нет
        # продолжаемой сессии — каждый заход это разовый запрос, агент
        # отвечает столько, сколько считает нужным, и выходит. На большой
        # задаче он честно останавливается посреди работы («работа не
        # готова, а остановлена» — его же слова на задаче по переносу чата),
        # и без внешнего повтора карточка так и замирает на середине.
        # В режиме ответа заход ровно один: работу тут никто не двигает,
        # цепочка повторов только надоедала бы владельцу.
        max_runs = (1 if reply_only else
                    MAX_RUNS_ORCHESTRATOR if agent.get("role") == "orchestrator"
                    else MAX_RUNS)
        for run in range(1, max_runs + 1):
            before = activity_mark(task_id)
            if run > 1:
                log(f"  зову «{agent['name']}» снова (заход {run} из {max_runs})")
                if claude_cli:
                    cmd = make_cmd(resume_text(get_task(task_id) or task),
                                   ["--resume", session_sid])
            proc = subprocess.Popen(
                cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                env=run_env,
                cwd=str(HOME) if claude_cli else str(HOME / "Проекты/New-Todoist"),
            )
            with LOCK:
                RUNNING[task_id] = (proc, assignee_id)
            box = {"proc": proc}
            hush = threading.Event()
            threading.Thread(
                target=silence_watch,
                args=(task_id, box, hush, agent["name"]),
                daemon=True,
            ).start()
            try:
                out, _ = proc.communicate(timeout=3600)
            finally:
                hush.set()
            tail = (out or "").strip()[-400:]
            log(f"  «{agent['name']}» закончил заход {run} (код {proc.returncode}): {tail}")
            spent = read_usage(usage_path)
            if spent:
                log(f"  расход захода: {spent}")
                note(task_id, f"Расход захода: {spent}", token=token)
            elif model and (flag or dsh_home):
                shown = model
                if dsh_home:
                    route = dsh_model_route(model)
                    if route:
                        shown = f"{route[1]} ({route[0]})"
                if run == 1:
                    note(task_id, f"Модель: {shown}", token=token)
            if reply_only:
                break
            if proc.returncode != 0:
                log(f"  «{agent['name']}» завершился с ошибкой (код {proc.returncode}) — цепочку останавливаю")
                break
            cont, why = should_continue(task_id, before)
            if not cont:
                log(f"  цепочку останавливаю: {why}")
                break
        # Итог доставки (Review 07.09.2026: сбой сразу оставляет видимую
        # blocked-причину): цепочка отработала — done, последний заход упал
        # с кодом — blocked с причиной. Мягко: сбой пометки не роняет выход.
        if inbox_events:
            rc = proc.returncode
            if rc == 0:
                inbox_mark(inbox_events, "done", token)
            else:
                inbox_mark(inbox_events, "blocked", token,
                           f"заход завершился с кодом {rc}")
    finally:
        stop.set()
        with LOCK:
            RUNNING.pop(task_id, None)


def run_hermes(task: dict, reason: str, agent: dict) -> None:
    """Разовый заход. Бессмертная сессия для Гермеса снята."""
    run_external(task, reason, agent)


def run_orchestrator(task: dict, reason: str, agent: dict) -> None:
    """Разовый заход. Оркестратор — dsh через find_dsh(), отдельной сессии нет."""
    run_external(task, reason, agent)


def agent_id_of(agent: dict) -> str:
    """id учётки агента в TaskFlow по его записи в карте."""
    if agent.get("id"):
        return str(agent["id"])
    for uid, spec in EXTERNAL_AGENTS.items():
        if spec is agent:
            return uid
    return ""


# Нить «родитель-ребёнок».
CHILD_LINK = re.compile(r"координационной задачи\s*#?\s*([0-9a-fA-F-]{36})")


def parent_task_id(task: dict) -> str:
    """id координационной задачи, куском которой является эта, или пусто."""
    if task.get("parent_id"):
        return str(task["parent_id"])
    m = CHILD_LINK.search(task.get("description") or "")
    return m.group(1) if m else ""


def wake_parent(child: dict, owner_id: str) -> bool:
    """Ребёнок сдался — поднять оркестратора на ЕГО карточке. True, если разбудили."""
    state = child.get("agent_state")
    if state not in ("review", "blocked"):
        return False
    parent_id = parent_task_id(child)
    if not parent_id or parent_id == child.get("id"):
        return False
    parent = get_task(parent_id)
    if not parent:
        return False
    parent_assignee = parent.get("assignee_id")
    parent_agent = EXTERNAL_AGENTS.get(parent_assignee or "")
    if parent_agent is None:
        return False

    what = "сдал работу на проверку" if state == "review" else "упёрся и ждёт решения"
    log(f"  ребёнок {str(child.get('id'))[:8]} {what} → бужу оркестратора на задаче {parent_id[:8]}")
    handle_task(parent_id, f"ребёнок «{child.get('title')}» {what}", kind="child_state_changed", owner_id=parent_assignee)
    return True


def handle_task(task_id: str, why: str, kind: str = "", actor_id: str = "",
                owner_id: str = "") -> None:
    """owner_id — чьё соединение принесло событие."""
    task = get_task(task_id)
    if not task:
        return

    # Если сдан ребёнок — будим Оркестратора на родительской карточке!
    if task.get("agent_state") in ("review", "blocked") and parent_task_id(task):
        if wake_parent(task, owner_id):
            return

    ok, reason = decide(task, kind, actor_id)
    if not ok:
        log(f"  {why}: {reason} — не берусь")
        return

    agent = EXTERNAL_AGENTS.get(task.get("assignee_id") or "")
    role = task.get("role")
    if not role and task.get("assignee_role") in ROLE_NAMES:
        role = task.get("assignee_role")
    if role:
        routed = resolve_agent_for_role(str(role))
        if routed is not None:
            agent = routed
        else:
            log(f"роль {role}: оставляю текущее назначение, оболочка недоступна")
    if agent:
        threading.Thread(
            target=run_external, args=(task, reason, agent), daemon=True
        ).start()
    else:
        log(f"{why}: активного исполнителя нет — не запускаю старую оболочку")


def wake_creator(task: dict, owner_id: str, agent: dict) -> bool:
    """Создатель карточки — оркестратор, и по ней пришёл сигнал «готово/упёрся».

    Сюда попадает ЛЮБАЯ карточка, не сданная и не заблокированная тем, кто её
    раздавал (см. handle_task → wake_creator). Это второй заход после
    wake_parent: тот закрывает дыру «ребёнок → координационная карточка через
    CHILD_LINK», а этот — общий случай, когда координационной нет вовсе или
    связь не прописана. Закрывает ту же жалобу, что и wake_parent
    (28–29.08.2026, владелец: «он сдал, а я узнаю через час»), но держится
    не на тексте описания, а на creator_id — поле, которое сервер заполняет
    сам и врать не может.

    Никакого claim и аренды: карточка остаётся у исполнителя, иначе это уже
    не сигнал о готовности, а захват работы. Сообщение в чат координации —
    единственное действие: резидент видит его и реагирует, а если резидента
    нет, следующий заход оркестратора увидит то же сообщение в ленте.

    От дублей защищает CREATOR_WAKED: одно уведомление в окне
    CREATOR_WAKED_TTL_SEC на одну задачу, даже если сервер прислал его и в
    WS-сокет, и сохранил в notifications под catch_up.
    """
    if not task:
        return False
    if task.get("creator_id") != owner_id:
        return False                       # не моя карточка — не моё дело
    if task.get("assignee_id") == owner_id:
        return False                       # это ЕГО собственная карточка,
                                           # не ребёнок — о ней будит REPLY_ONLY
    state = task.get("agent_state")
    if state not in ("review", "blocked"):
        return False
    task_id = task["id"]
    now = time.time()
    with LOCK:
        last = CREATOR_WAKED.get(task_id, 0.0)
        if now - last < CREATOR_WAKED_TTL_SEC:
            log(f"  создателя по {task_id[:8]} уже уведомляли "
                f"{int(now - last)} с назад — не дублирую")
            return True
        CREATOR_WAKED[task_id] = now
    what = "сдал работу на проверку" if state == "review" else "упёрся и ждёт решения"
    title = (task.get("title") or "")[:80]

    # 29.08.2026, владелец, дословно: «на хуя уведомление, у нас каждый агент
    # тебе сам написать может». Правило «сдал или упёрся — скажи оркестратору
    # в чат» вписано в задание всем исполнителям и работает, поэтому служебное
    # сообщение стало вторым про одно и то же. Хуже, чем просто шум: оно
    # приходит от учётки Claude_Bot, выглядит как влезший в разговор третий
    # агент, и каждой доставкой сбивает чужие сессии посреди работы —
    # «этот долбоёб дублируется, Гермес сбрасывается».
    # Оркестратор узнаёт о сдаче от самого исполнителя; доска на месте, если
    # тот промолчал.
    log(f"  {task_id[:8]}: исполнитель {what} — уведомление не шлю, "
        "об этом говорит он сам")
    return True

    # Шлём от имени службы: from_user_id отбрасывает собственное эхо,
    # to_user_id — это и есть оркестратор.
    sent = api("POST", "/api/chat", {
        "text": (f"Исполнитель {what} по задаче «{title}» "
                 f"(#{task_id[:8]}). Карточка остаётся на проверке — "
                 "загляни и реши, что с ней делать."),
        "to_user_id": agent_id_of(agent),
        "task_id": task_id,
        "kind": "делегирование",
    }) if os.environ.get("TASKFLOW_TRIGGER_DRY") != "1" else {"dry": True}
    if sent is None:
        log(f"  не смог уведомить создателя-оркестратора о {task_id[:8]} — "
            "чат не принял сообщение")
        # Откатываем метку, чтобы следующая попытка не ушла в TTL-молчание.
        with LOCK:
            CREATOR_WAKED.pop(task_id, None)
        return False
    log(f"  «{task_id[:8]}» {what} → сообщил создателю «{agent['name']}» в чат")
    return True


def catch_up(owner_id: str = ME, token: str = "") -> None:
    """Непрочитанные уведомления, накопившиеся пока службы не было.

    ⚠️ Ходит ключом ТОГО соединения, которое её вызвало. Иначе соединение
    Гермеса добирало мои уведомления и не видело его собственных: 21.08.2026
    у него висели три непрочитанных «assigned», а служба молчала — «не берёт
    в работу, будильник не зовёт».
    """
    items = api("GET", "/api/notifications", token=token) or []
    pending = [n for n in items if not n.get("read") and n.get("actor_id") != owner_id]
    if pending:
        log(f"добираю пропущенное: {len(pending)} уведомлений")
    for n in pending:
        if n.get("task_id"):
            handle_task(n["task_id"], f"пропущенное уведомление ({n.get('type')})",
                        n.get("type") or "", n.get("actor_id") or "", owner_id)
        # Сухой прогон ничего не меняет — в том числе не гасит непрочитанные
        # уведомления владельца: проверка службы не должна вычищать за него
        # колокольчик.
        if os.environ.get("TASKFLOW_TRIGGER_DRY") != "1":
            api("PATCH", f"/api/notifications/{n['id']}/read", {}, token=token)


def on_message_for(owner_id: str, token: str):
    """Обработчик под конкретную учётку: у каждого соединения свой адресат."""

    def handler(_ws, raw: str) -> None:
        _on_message(raw, owner_id, token)

    return handler


def _on_message(raw: str, owner_id: str = ME, token: str = "") -> None:
    try:
        event = json.loads(raw)
    except Exception:
        return
    kind = event.get("type")
    if kind == "connected":
        log(f"сокет открыт ({owner_id}) — агент «онлайн» на экране агентов")
        catch_up(owner_id, token)
        return
    if kind == "chat:new":
        message = event.get("message") or {}
        to_user_id = message.get("to_user_id")
        task_id = message.get("task_id")
        if task_id and to_user_id:
            agent = EXTERNAL_AGENTS.get(to_user_id)
            if agent and to_user_id == PI_AGENT_ID:
                log(f"  чат: новое сообщение для Pi Agent по задаче {task_id[:8]} → будю Pi")
                handle_task(task_id, f"чат от {message.get('from_user_name', 'агента')}", kind="chat", owner_id=to_user_id)
        return
    if kind != "notification:new":
        return
    task_id = event.get("taskId")
    if not task_id:
        return
    # Уведомление приходит только адресату, но действие мог совершить и сам
    # агент (например, комментарий от себя) — такие поводы пропускаем, иначе
    # отчёт разбудил бы сам себя.
    items = api("GET", "/api/notifications", token=token) or []
    this = next((n for n in items if n.get("id") == event.get("notificationId")), None)
    if this and this.get("actor_id") == owner_id:
        log("  моё же действие — не повод")
        return
    actor = (this or {}).get("actor_name") or "кто-то"
    kind = (this or {}).get("type") or ""
    handle_task(task_id, f"{actor}: {kind or 'событие'}", kind,
                (this or {}).get("actor_id") or "", owner_id)


def listen(owner_id: str, token: str, who: str) -> None:
    """Держать соединение за одну учётку и не отпускать.

    Своё соединение на каждого обслуживаемого агента: уведомления сервер
    доставляет только адресату, и чужие события в чужой сокет не приходят.
    """
    while True:
        try:
            ws = websocket.WebSocketApp(
                f"{WS_URL}?token={token}",
                on_message=on_message_for(owner_id, token),
                on_error=lambda _w, e, w=who: log(f"сокет {w}: сбой {e}"),
                on_close=lambda _w, *_, w=who: log(f"сокет {w} закрыт — переподключаюсь"),
            )
            ws.run_forever(ping_interval=30, ping_timeout=10)
        except Exception as e:
            log(f"цикл соединения {who} упал: {e}")
        time.sleep(5)


def alive_beat_loop() -> None:
    """Отпечаток «я жив и в главном цикле» каждые ALIVE_BEAT_SEC секунд.

    Зачем отдельный файл, если есть trigger.log: лог пишется только когда
    есть ЧТО сказать. 29.08.2026 посчитали по живому логу — за 12 часов семь
    пауз длиннее десяти минут, самая длинная 125, и все они нормальная
    тишина, а не отказ. Внешний сторож (trigger_watch.py) по логу не может
    отличить «молчит, потому что работы нет» от «молчит, потому что завис»,
    и слал бы ложные тревоги каждую спокойную ночь. Этот файл обновляется по
    ТАЙМЕРУ, а не по событиям, поэтому его mtime и означает «процесс в цикле».
    """
    while True:
        try:
            STATE_DIR.mkdir(parents=True, exist_ok=True)
            tmp = ALIVE_FILE.with_suffix(".tmp")
            tmp.write_text(datetime.now(timezone.utc).isoformat(timespec="seconds"))
            os.replace(tmp, ALIVE_FILE)
        except OSError as exc:
            log(f"  ⚠️ не записать {ALIVE_FILE}: {exc}")
        time.sleep(ALIVE_BEAT_SEC)


def main() -> None:
    global ROLE_ROUTING
    try:
        routing = load_role_routing()
        validate_role_agents(routing)
        validate_pi_mcp_profiles()
    except (RuntimeError, ValueError) as exc:
        log(f"матрица role-routing.yaml не прошла проверку: {exc}")
        sys.exit(1)
    ROLE_ROUTING = routing
    log(f"матрица маршрутизации ролей загружена: {len(routing['defaults'])} ролей")

    # В рабочем режиме есть только ключ Pi Agent. Старые ключи намеренно не
    # перечисляются и не читаются.
    for uid, agent in list(EXTERNAL_AGENTS.items()):
        token = os.environ.get(agent.get("token_env", ""), "").strip()
        if not token and "token_static" in agent:
            token = agent["token_static"]
        agent["token"] = token
        if agent["cmd"] is None:
            agent["cmd"] = find_dsh()
        if not agent["token"] or not agent["cmd"]:
            why = "нет ключа" if not agent["token"] else "не установлен"
            log(f"«{agent['name']}»: {why} — его задачи не обслуживаю")
            EXTERNAL_AGENTS.pop(uid)

    if not TOKEN:
        print("Нет TASKFLOW_TOKEN в окружении — служба запускается через vault-run.py", file=sys.stderr)
        sys.exit(1)
    log("будильник TaskFlow запущен")

    # Поднимаем одно соединение Pi Agent. Никаких дополнительных соединений
    # под старыми учётками больше нет.
    for uid, agent in EXTERNAL_AGENTS.items():
        threading.Thread(
            target=listen, args=(uid, agent["token"], agent["name"]), daemon=True
        ).start()
        log(f"слушаю задачи «{agent['name']}»")

    # ⚠️ Всё, что должно крутиться параллельно, поднимается ДО listen(ME):
    # он внутри себя держит вечный цикл и управление из него не возвращается.
    # 29.08.2026 на этом попались — обход доски стоял ПОСЛЕ него и не работал
    # ни разу за две недели (в логе ноль строк «обход:»), назначенные
    # карточки подбирались только по случайному событию.
    threading.Thread(target=alive_beat_loop, daemon=True).start()
    log(f"отпечаток живости обновляется каждые {ALIVE_BEAT_SEC}с: {ALIVE_FILE}")

    threading.Thread(target=board_scan_loop, daemon=True).start()
    log("обход доски включён — каждые "
        f"{BOARD_SCAN_SEC // 60} мин проверяю назначенных без исполнителя")

    listen(ME, TOKEN, "Pi Agent")


if __name__ == "__main__":
    main()
