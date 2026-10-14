"""Секретарь: голосовой воркер LiveKit. Запуск: см. systemd-юнит
taskflow-secretary-voice.service. Ручной прогон (dev):
  ~/.venvs/secretary-voice/bin/python3 worker.py dev
"""
from __future__ import annotations

import asyncio
import logging
import os
import json
from typing import Awaitable, Callable
from dataclasses import dataclass

import aiohttp
from dotenv import load_dotenv

from livekit.agents import (
    Agent,
    AgentServer,
    AgentSession,
    JobContext,
    RunContext,
    cli,
    function_tool,
)
from livekit.plugins.google.realtime import RealtimeModel

load_dotenv()

logger = logging.getLogger("secretary-voice")


class ConfigError(Exception):
    """Обязательная переменная окружения не задана."""


@dataclass(frozen=True)
class Config:
    livekit_url: str
    livekit_api_key: str
    livekit_api_secret: str
    gemini_api_key: str
    taskflow_socket_path: str


REQUIRED_VARS = (
    "LIVEKIT_URL",
    "LIVEKIT_API_KEY",
    "LIVEKIT_API_SECRET",
    "GEMINI_API_KEY",
)


def load_config() -> Config:
    missing = [v for v in REQUIRED_VARS if not os.environ.get(v)]
    if missing:
        raise ConfigError(f"не заданы переменные окружения: {', '.join(missing)}")
    return Config(
        livekit_url=os.environ["LIVEKIT_URL"],
        livekit_api_key=os.environ["LIVEKIT_API_KEY"],
        livekit_api_secret=os.environ["LIVEKIT_API_SECRET"],
        gemini_api_key=os.environ["GEMINI_API_KEY"],
        taskflow_socket_path=os.environ.get("TASKFLOW_VOICE_SOCKET", os.path.join(
            os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}"),
            "taskflow-secretary", "voice.sock")),
    )


SECRETARY_INSTRUCTIONS = (
    "Ты — Секретарь, голосовой помощник Максима в TaskFlow. Отвечай кратко "
    "и по-русски. Не используй эмодзи и markdown — тебя слушают. "
    "По просьбе создать задачу вызови create_task с полным текстом поручения. "
    "Не превращай его в короткий заголовок: сохрани сроки, время, приоритет, "
    "метки, исполнителя и все детали. Не разбирай поля и не назначай роли сам: "
    "постановку разбирает общий серверный канал с промптами владельца. "
    "Если владелец уточнил поручение до создания, включи уточнение в полный текст. "
    "После ответа инструмента озвучь сохранённые значения; если есть questions, "
    "задай эти вопросы и скажи, что карточка осталась черновиком. "
    "Не создавай повторную карточку просто из-за уточнения. Если запрос "
    "неясен до вызова, сначала переспроси. "
    "Для сведений о задачах любых ролей, завершённых, зависших, просроченных "
    "или будущих сроках всегда вызывай task_summary с полным запросом. "
    "Зависшие — назначенные, но не взятые, и заблокированные; просроченные отдельно. "
    "Не придумывай статусы, причины или даты. Передай период серверу. "
    "Если просят прислать, написать или скинуть сводку в чат, send_to_chat=true; "
    "иначе false. После успешного message_id скажи, что сводка отправлена в чат. "
    "Для краткого ответа используй spoken_text; по просьбе подробностей озвучь "
    "факты из sections без технических id. Если есть question, переспроси. "
    "Не создавай задачу вместо запроса информации."
)

DEFAULT_VOICE = "Puck"
# Тот же закрытый список, что в POST /api/secretary/voice-token и настройках
# приложения: Gemini Live незнакомое имя молча подменяет своим голосом.
SECRETARY_VOICES = frozenset({"Puck", "Charon", "Kore", "Fenrir", "Aoede", "Leda", "Orus", "Zephyr"})


def pick_voice(attributes: dict[str, str]) -> str:
    voice = attributes.get("voice")
    return voice if voice in SECRETARY_VOICES else DEFAULT_VOICE


async def create_task_via_api(text: str, socket_path: str, owner_id: str) -> dict:
    # Unix socket доступен только процессам владельца сервера. Старый
    # постоянный ключ не читаем и не передаём.
    connector = aiohttp.UnixConnector(path=socket_path)
    async with aiohttp.ClientSession(connector=connector, timeout=aiohttp.ClientTimeout(total=240)) as http:
        async with http.post(
            "http://localhost/secretary/tasks",
            json={"text": text, "owner_id": owner_id},
        ) as resp:
            body = await resp.json()
            if resp.status not in (200, 201):
                raise RuntimeError(f"TaskFlow отказал: {body.get('error', resp.status)}")
            return body


async def summary_via_api(text: str, socket_path: str, owner_id: str, send_to_chat: bool = False) -> dict:
    connector = aiohttp.UnixConnector(path=socket_path)
    async with aiohttp.ClientSession(connector=connector, timeout=aiohttp.ClientTimeout(total=240)) as http:
        async with http.post("http://localhost/secretary/summary",
                             json={"text": text, "owner_id": owner_id, "send_to_chat": send_to_chat}) as resp:
            body = await resp.json()
            if resp.status != 200:
                raise RuntimeError(f"TaskFlow отказал: {body.get('error', resp.status)}")
            return body


async def lookup_via_api(path: str, socket_path: str, owner_id: str, text: str = "") -> dict:
    connector = aiohttp.UnixConnector(path=socket_path)
    async with aiohttp.ClientSession(connector=connector, timeout=aiohttp.ClientTimeout(total=30)) as http:
        async with http.post(f"http://localhost/secretary/{path}", json={"text": text, "owner_id": owner_id}) as resp:
            body = await resp.json()
            if resp.status != 200:
                raise RuntimeError(f"TaskFlow отказал: {body.get('error', resp.status)}")
            return body


# Фон для долгих инструментов (владелец 14.10.2026): раньше Секретарь молча
# ждала инструмент до 2–4 минут, и в звонке была тишина, «как будто сказал в
# пустоту». Теперь инструмент ждём недолго; не успел — модель сразу получает
# «принято, выполняется», говорит это владельцу и продолжает разговор, а итог
# по готовности сам подаётся в разговор отдельной репликой.
QUICK_ANSWER_SECONDS = 3.0
BACKGROUND_ACK = (
    "Запрос «{label}» принят и выполняется в фоне. Прямо сейчас одной короткой фразой "
    "скажи владельцу, что приняла и запустила, и спроси, есть ли что-то ещё. "
    "Итог придёт сам отдельным сообщением — повторно этот инструмент не вызывай."
)
BACKGROUND_RESULT = (
    "Пришёл результат фонового запроса «{label}». Коротко и по делу сообщи владельцу итог; "
    "если он сейчас говорит о другом, сначала одной фразой предупреди, что пришёл ответ. Данные: {result}"
)


class BackgroundRunner:
    """Ответ сразу, если инструмент быстрый; иначе — фон и доклад по готовности."""

    def __init__(self, quick_seconds: float = QUICK_ANSWER_SECONDS) -> None:
        self.quick_seconds = quick_seconds
        self.session: AgentSession | None = None
        self.jobs: set[asyncio.Future] = set()

    async def run(self, label: str, work: Callable[[], Awaitable[str]]) -> str:
        job = asyncio.ensure_future(work())
        try:
            return await asyncio.wait_for(asyncio.shield(job), self.quick_seconds)
        except asyncio.TimeoutError:
            pass
        self.jobs.add(job)
        job.add_done_callback(lambda done: self._report(label, done))
        logger.info("инструмент «%s» ушёл в фон", label)
        return BACKGROUND_ACK.format(label=label)

    def _report(self, label: str, job: asyncio.Future) -> None:
        self.jobs.discard(job)
        try:
            result = job.result()
        except Exception as exc:  # инструмент сам ловит свои ошибки; это — запас
            result = f"не получилось: {exc}"
        if self.session is None:
            return
        try:
            self.session.generate_reply(instructions=BACKGROUND_RESULT.format(label=label, result=result))
        except Exception as exc:  # звонок уже закончился — сделанное на сервере остаётся
            logger.warning("итог «%s» не озвучен: %s", label, exc)


async def shared_tools_via_api(socket_path: str, owner_id: str, runner: BackgroundRunner | None = None) -> list:
    """Общие инструменты Секретаря (те же, что в чате) — как инструменты звонка."""
    connector = aiohttp.UnixConnector(path=socket_path)
    async with aiohttp.ClientSession(connector=connector, timeout=aiohttp.ClientTimeout(total=15)) as http:
        async with http.get("http://localhost/secretary/tools") as response:
            if response.status != 200:
                raise RuntimeError("Не удалось получить список инструментов")
            specs = (await response.json()).get("tools", [])

    def build(spec: dict):
        async def call(raw_arguments: dict[str, object]) -> str:
            if runner is None:
                return await invoke(raw_arguments)
            return await runner.run(spec["name"], lambda: invoke(raw_arguments))

        async def invoke(raw_arguments: dict[str, object]) -> str:
            inner = aiohttp.UnixConnector(path=socket_path)
            try:
                async with aiohttp.ClientSession(connector=inner, timeout=aiohttp.ClientTimeout(total=120)) as http:
                    async with http.post("http://localhost/secretary/tool",
                                         json={"owner_id": owner_id, "name": spec["name"], "arguments": raw_arguments}) as resp:
                        body = await resp.json()
            except (aiohttp.ClientError, TimeoutError) as exc:
                return f"Инструмент недоступен: {exc}"
            if body.get("ok"):
                return body.get("result", "")
            return f"Инструмент отказал: {body.get('error', 'неизвестная ошибка')}"
        return function_tool(call, raw_schema={"name": spec["name"], "description": spec["description"], "parameters": spec["parameters"]})

    return [build(spec) for spec in specs]


async def instructions_via_api(socket_path: str) -> dict:
    connector = aiohttp.UnixConnector(path=socket_path)
    async with aiohttp.ClientSession(connector=connector, timeout=aiohttp.ClientTimeout(total=15)) as http:
        async with http.get("http://localhost/secretary/instructions") as response:
            if response.status != 200:
                raise RuntimeError("Не удалось получить инструкции Секретаря")
            body = await response.json()
            if not isinstance(body.get("instructions"), str) or not isinstance(body.get("greeting"), str):
                raise RuntimeError("Неверный формат инструкций Секретаря")
            return body


class Assistant(Agent):
    def __init__(self, owner_id: str, instructions: str = SECRETARY_INSTRUCTIONS, greeting: str = "поздоровайся коротко и спроси, чем помочь", tools: list | None = None, runner: BackgroundRunner | None = None) -> None:
        super().__init__(instructions=instructions, tools=tools or [])
        self.owner_id = owner_id
        self.greeting = greeting
        self.runner = runner or BackgroundRunner()

    async def on_enter(self) -> None:
        self.session.generate_reply(instructions=self.greeting)

    @function_tool
    async def create_task(self, context: RunContext, text: str) -> str:
        """Передать полное поручение общему серверному разбору постановки задач.

        Args:
            text: Полный текст поручения со сроком, временем, метками, приоритетом,
                исполнителем и деталями. Не сокращай его до названия.
        """
        async def work() -> str:
            cfg = load_config()
            try:
                result = await create_task_via_api(text, cfg.taskflow_socket_path, self.owner_id)
            except (RuntimeError, aiohttp.ClientError, TimeoutError) as exc:
                return f"Не получилось разобрать поручение: {exc}"
            return json.dumps(result, ensure_ascii=False)
        return await self.runner.run("постановка задачи", work)

    @function_tool
    async def task_summary(self, context: RunContext, text: str, send_to_chat: bool = False) -> str:
        """Получить фактическую сводку задач любого исполнителя или всех ролей.

        Args:
            text: Полная просьба, включая исполнителя, статусы и период (неделя, месяц, даты).
            send_to_chat: True только если владелец просит прислать сводку в чат.
        """
        async def work() -> str:
            cfg = load_config()
            try:
                result = await summary_via_api(text, cfg.taskflow_socket_path, self.owner_id, send_to_chat)
            except (RuntimeError, aiohttp.ClientError, TimeoutError) as exc:
                return f"Не удалось получить сводку: {exc}"
            return json.dumps(result, ensure_ascii=False)
        return await self.runner.run("сводка задач", work)

    @function_tool
    async def task_details(self, context: RunContext, text: str) -> str:
        """Всё об одной задаче: состояние, шаги плана и кто их делал, вердикт проверки, интеграция, последние комментарии.

        Args:
            text: Название задачи или слова из него, как их назвал владелец.
        """
        async def work() -> str:
            cfg = load_config()
            try:
                result = await lookup_via_api("task", cfg.taskflow_socket_path, self.owner_id, text)
            except (RuntimeError, aiohttp.ClientError, TimeoutError) as exc:
                return f"Не удалось посмотреть задачу: {exc}"
            return json.dumps(result, ensure_ascii=False)
        return await self.runner.run("карточка задачи", work)

    @function_tool
    async def send_to_owner_chat(self, context: RunContext, text: str) -> str:
        """Написать владельцу в его чат с Секретарём: всё, что он просит прислать текстом.

        Args:
            text: Полный текст сообщения, готовый к чтению.
        """
        async def work() -> str:
            cfg = load_config()
            try:
                result = await lookup_via_api("owner-chat", cfg.taskflow_socket_path, self.owner_id, text)
            except (RuntimeError, aiohttp.ClientError, TimeoutError) as exc:
                return f"Не удалось написать в чат: {exc}"
            return json.dumps(result, ensure_ascii=False)
        return await self.runner.run("сообщение в чат", work)

    @function_tool
    async def role_load(self, context: RunContext) -> str:
        """Загрузка ролей: чем сейчас занята каждая роль, что в очереди и что заблокировано."""
        async def work() -> str:
            cfg = load_config()
            try:
                result = await lookup_via_api("roles", cfg.taskflow_socket_path, self.owner_id)
            except (RuntimeError, aiohttp.ClientError, TimeoutError) as exc:
                return f"Не удалось посмотреть загрузку ролей: {exc}"
            return json.dumps(result, ensure_ascii=False)
        return await self.runner.run("загрузка ролей", work)


# LiveKit SDK ignores NO_PROXY when it takes HTTPS_PROXY implicitly.
# Its signaling route is configured separately from the Gemini route.
server = AgentServer(http_proxy=os.getenv("LIVEKIT_HTTP_PROXY"), num_idle_processes=1)


@server.rtc_session()
async def entrypoint(ctx: JobContext) -> None:
    ctx.log_context_fields = {"room": ctx.room.name}
    cfg = load_config()

    await ctx.connect()
    owner = await ctx.wait_for_participant()
    voice = pick_voice(owner.attributes)
    logger.info("голос Секретаря: %s", voice)

    session = AgentSession(
        llm=RealtimeModel(
            model="gemini-3.8-live",
            api_key=cfg.gemini_api_key,
            voice=voice,
        ),
    )
    snapshot = await instructions_via_api(cfg.taskflow_socket_path)
    runner = BackgroundRunner()
    runner.session = session
    try:
        shared = await shared_tools_via_api(cfg.taskflow_socket_path, owner.identity, runner)
    except (RuntimeError, aiohttp.ClientError, TimeoutError) as exc:
        # Звонок важнее полного набора: без общих инструментов остаются базовые.
        logger.warning("общие инструменты Секретаря недоступны: %s", exc)
        shared = []
    await session.start(agent=Assistant(owner_id=owner.identity, instructions=snapshot["instructions"], greeting=snapshot["greeting"], tools=shared, runner=runner), room=ctx.room)

    # Тап по анимации на телефоне — перебить Секретаря на полуслове.
    @ctx.room.local_participant.register_rpc_method("interrupt")
    async def _interrupt(_data) -> str:
        session.interrupt()
        return "ok"


if __name__ == "__main__":
    load_config()  # падаем рано и явно, не на первом же job
    cli.run_app(server)
