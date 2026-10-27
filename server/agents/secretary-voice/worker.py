"""Помощник владельца: голосовой воркер LiveKit. Запуск: см. systemd-юнит
taskflow-secretary-voice.service. Ручной прогон (dev):
  ~/.venvs/secretary-voice/bin/python3 worker.py dev
"""
from __future__ import annotations

import asyncio
from collections import deque
import logging
import os
import uuid
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
    llm,
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
    "Ты — Помощник владельца, голосовой помощник Максима в TaskFlow. Отвечай кратко "
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


# Род речи — по выбранному голосу (владелец 14.10.2026): мужской голос
# говорит о себе в мужском роде, женский — в женском.
MALE_VOICES = frozenset({"Puck", "Charon", "Fenrir", "Orus"})


def gender_instruction(voice: str) -> str:
    if voice in MALE_VOICES:
        return ("Ты говоришь мужским голосом: о себе всегда в мужском роде "
                "(«я понял», «я принял», «я запустил»), никогда в женском.")
    return ("Ты говоришь женским голосом: о себе всегда в женском роде "
            "(«я поняла», «я приняла», «я запустила»), никогда в мужском.")


async def create_task_via_api(text: str, socket_path: str, owner_id: str, chat_id: str | None = None) -> dict:
    # Unix socket доступен только процессам владельца сервера. Старый
    # постоянный ключ не читаем и не передаём.
    connector = aiohttp.UnixConnector(path=socket_path)
    async with aiohttp.ClientSession(connector=connector, timeout=aiohttp.ClientTimeout(total=240)) as http:
        async with http.post(
            "http://localhost/secretary/tasks",
            json={"text": text, "owner_id": owner_id, **({"chat_id": chat_id} if chat_id else {})},
        ) as resp:
            body = await resp.json()
            if resp.status not in (200, 201):
                raise RuntimeError(f"TaskFlow отказал: {body.get('error', resp.status)}")
            return body


async def summary_via_api(text: str, socket_path: str, owner_id: str, send_to_chat: bool = False, chat_id: str | None = None) -> dict:
    connector = aiohttp.UnixConnector(path=socket_path)
    async with aiohttp.ClientSession(connector=connector, timeout=aiohttp.ClientTimeout(total=240)) as http:
        async with http.post("http://localhost/secretary/summary",
                             json={"text": text, "owner_id": owner_id, "send_to_chat": send_to_chat, **({"chat_id": chat_id} if chat_id else {})}) as resp:
            body = await resp.json()
            if resp.status != 200:
                raise RuntimeError(f"TaskFlow отказал: {body.get('error', resp.status)}")
            return body


async def lookup_via_api(path: str, socket_path: str, owner_id: str, text: str = "", chat_id: str | None = None) -> dict:
    connector = aiohttp.UnixConnector(path=socket_path)
    async with aiohttp.ClientSession(connector=connector, timeout=aiohttp.ClientTimeout(total=30)) as http:
        async with http.post(f"http://localhost/secretary/{path}", json={"text": text, "owner_id": owner_id, **({"chat_id": chat_id} if chat_id else {})}) as resp:
            body = await resp.json()
            if resp.status != 200:
                raise RuntimeError(f"TaskFlow отказал: {body.get('error', resp.status)}")
            return body


# Фон для долгих инструментов (владелец 14.10.2026): раньше Помощник владельца молча
# ждала инструмент до 2–4 минут, и в звонке была тишина, «как будто сказал в
# пустоту». Теперь инструмент ждём недолго; не успел — модель сразу получает
# «принято, выполняется», говорит это владельцу и продолжает разговор, а итог
# по готовности сам подаётся в разговор отдельной репликой.
QUICK_ANSWER_SECONDS = 3.0
BACKGROUND_ACK = (
    "Запрос «{label}» принят и выполняется в фоне. Прямо сейчас одной короткой фразой "
    "скажи владельцу (в своём роде), что запрос принят и запущен, и спроси, есть ли что-то ещё. "
    "Итог придёт сам отдельным сообщением — повторно этот инструмент не вызывай."
)
BACKGROUND_RESULT = (
    "Пришёл результат фонового запроса «{label}». Коротко и по делу сообщи владельцу итог; "
    "если он сейчас говорит о другом, сначала одной фразой предупреди, что пришёл ответ. Данные: {result}"
)


class BackgroundRunner:
    """Фоновая работа и последовательная доставка результатов в паузах разговора."""

    def __init__(self, quick_seconds: float = QUICK_ANSWER_SECONDS) -> None:
        self.quick_seconds = quick_seconds
        self.session: AgentSession | None = None
        self.jobs: set[asyncio.Future] = set()
        self.pending: deque[tuple[str, str]] = deque()
        self._delivery: asyncio.Task | None = None
        self._closed = False

    async def run(self, label: str, work: Callable[[], Awaitable[str]]) -> str:
        job = asyncio.ensure_future(work())
        try:
            return await asyncio.wait_for(asyncio.shield(job), self.quick_seconds)
        except asyncio.TimeoutError:
            pass
        except asyncio.CancelledError:
            # Перебивание ожидания не отменяет уже начатое поручение и его доклад.
            self._track(label, job)
            raise
        self._track(label, job)
        logger.info("инструмент «%s» ушёл в фон", label)
        return BACKGROUND_ACK.format(label=label)

    def _track(self, label: str, job: asyncio.Future) -> None:
        self.jobs.add(job)
        job.add_done_callback(lambda done: self._report(label, done))

    def _report(self, label: str, job: asyncio.Future) -> None:
        self.jobs.discard(job)
        if job.cancelled():
            return
        try:
            result = job.result()
        except Exception as exc:
            result = f"не получилось: {exc}"
        self.pending.append((label, result))
        if self._closed or self.session is None:
            logger.warning("итог «%s» сохранён без озвучивания: звонок закрыт", label)
            return
        if self._delivery is None or self._delivery.done():
            self._delivery = asyncio.create_task(self._deliver())

    async def _deliver(self) -> None:
        failures = 0
        while self.pending and not self._closed:
            session = self.session
            if session is None:
                return
            # SDK ждёт окончания речи пользователя, ответа агента и обработки хода.
            try:
                await session.wait_for_idle()
            except Exception as exc:
                logger.warning("очередь результатов сохранена: %s", exc)
                return
            if self._closed:
                return
            # Состояние могло смениться при выходе wait_for_idle.
            if session.user_state == "speaking" or session.agent_state in ("speaking", "thinking"):
                await asyncio.sleep(0.05)
                continue
            label, result = self.pending[0]
            instructions = BACKGROUND_RESULT.format(label=label, result=result)
            try:
                speech = session.generate_reply(instructions=instructions)
                await speech
                error = speech.exception()
                interrupted = speech.interrupted
            except Exception as exc:
                error, interrupted = exc, False
            if error is not None:
                failures += 1
                logger.warning("доклад «%s» не завершён, повтор в очереди: %s", label, error)
                await asyncio.sleep(min(0.1 * 2 ** min(failures - 1, 6), 5.0))
                continue
            failures = 0
            if interrupted:
                # Поручение НЕ повторяем: повторяется только его недосказанный итог.
                await asyncio.sleep(0.05)
                continue
            self.pending.popleft()

    async def close(self, *_args) -> None:
        """Прекратить озвучивание при закрытии звонка; поручения не отменять."""
        self._closed = True
        self.session = None
        if self._delivery is not None and not self._delivery.done():
            self._delivery.cancel()
            await asyncio.gather(self._delivery, return_exceptions=True)


async def conversation_via_api(socket_path: str, owner_id: str, chat_id: str) -> list[dict]:
    connector = aiohttp.UnixConnector(path=socket_path)
    async with aiohttp.ClientSession(connector=connector, timeout=aiohttp.ClientTimeout(total=15)) as http:
        async with http.post("http://localhost/secretary/conversation", json={"owner_id": owner_id, "chat_id": chat_id}) as response:
            if response.status != 200:
                raise RuntimeError("Не удалось загрузить исходный чат")
            return (await response.json())["messages"]


async def transcript_via_api(socket_path: str, owner_id: str, chat_id: str, room: str, item_id: str, role: str, text: str) -> None:
    connector = aiohttp.UnixConnector(path=socket_path)
    async with aiohttp.ClientSession(connector=connector, timeout=aiohttp.ClientTimeout(total=15)) as http:
        async with http.post("http://localhost/secretary/transcript", json={"owner_id": owner_id, "chat_id": chat_id, "event_id": room + ":" + item_id, "role": role, "text": text}) as response:
            if response.status != 200:
                raise RuntimeError("Не удалось сохранить голосовую реплику")
            await response.read()


def context_from_messages(messages: list[dict]) -> llm.ChatContext:
    context = llm.ChatContext.empty()
    for message in messages:
        if message.get("role") in ("user", "assistant") and message.get("text"):
            context.add_message(role=message["role"], content=message["text"])
    return context


class VoiceConversationRecorder:
    """Последовательная запись финальных реплик; повтор HTTP безопасен по event_id."""

    def __init__(self, write: Callable[[str, str, str], Awaitable[None]]) -> None:
        self._write = write
        self._pending: deque[tuple[str, str, str]] = deque()
        self._seen: set[str] = set()
        self._task: asyncio.Task | None = None
        self._closed = False

    def record(self, item) -> None:
        if self._closed or not isinstance(item, llm.ChatMessage):
            return
        text = item.text_content
        if item.role not in ("user", "assistant") or not text or not text.strip() or item.id in self._seen:
            return
        self._seen.add(item.id)
        self._pending.append((item.id, item.role, text))
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._drain())

    async def _drain(self) -> None:
        while self._pending:
            try:
                await self._write(*self._pending[0])
            except Exception as exc:
                logger.warning("расшифровка ждёт повторной записи в чат: %s", exc)
                await asyncio.sleep(0.2)
                continue
            self._pending.popleft()

    async def flush(self, timeout: float = 2.0) -> bool:
        if self._task is not None:
            try:
                await asyncio.wait_for(asyncio.shield(self._task), timeout)
            except asyncio.TimeoutError:
                return False
        return not self._pending

    async def close(self, *_args) -> None:
        self._closed = True
        if not await self.flush():
            logger.error("звонок завершён с %s несохранёнными репликами", len(self._pending))
        if self._task is not None and not self._task.done():
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)


async def shared_tools_via_api(socket_path: str, owner_id: str, runner: BackgroundRunner | None = None, chat_id: str | None = None, recorder: VoiceConversationRecorder | None = None, agent: Agent | None = None, session_id: str | None = None) -> list:
    """Общие инструменты Помощника владельца (те же, что в чате) — как инструменты звонка."""
    connector = aiohttp.UnixConnector(path=socket_path)
    async with aiohttp.ClientSession(connector=connector, timeout=aiohttp.ClientTimeout(total=60)) as http:
        async with http.get("http://localhost/secretary/tools", params={"owner_id": owner_id, **({"chat_id": chat_id} if chat_id else {}), **({"session_id": session_id} if session_id else {})}) as response:
            if response.status != 200:
                raise RuntimeError("Не удалось получить список инструментов")
            specs = (await response.json()).get("tools", [])
            if not specs or not any(spec.get("name") == "taskflow_tools" for spec in specs):
                raise RuntimeError("Голосовой каталог неполон: нет отдельных инструментов и taskflow_tools")

    def build(spec: dict):
        async def call(raw_arguments: dict[str, object]) -> str:
            # Загрузчик должен обновить схемы до следующего запроса модели.
            if runner is None or spec["name"] == "taskflow_tools":
                return await invoke(raw_arguments)
            return await runner.run(spec["name"], lambda: invoke(raw_arguments))

        async def invoke(raw_arguments: dict[str, object]) -> str:
            if recorder is not None:
                await recorder.flush()
            inner = aiohttp.UnixConnector(path=socket_path)
            try:
                async with aiohttp.ClientSession(connector=inner, timeout=aiohttp.ClientTimeout(total=120)) as http:
                    async with http.post("http://localhost/secretary/tool",
                                         json={"owner_id": owner_id, "name": spec["name"], "arguments": raw_arguments, "session_id": session_id, "call_id": str(uuid.uuid4()), **({"chat_id": chat_id} if chat_id else {})}) as resp:
                        body = await resp.json()
            except (aiohttp.ClientError, TimeoutError) as exc:
                return f"Инструмент недоступен: {exc}"
            if body.get("ok"):
                if "tools" in body:
                    if agent is None:
                        return "Не удалось подключить инструменты: голосовой агент не привязан."
                    await agent.update_tools([build(item) for item in body["tools"]])
                return body.get("result", "")
            return f"Инструмент отказал: {body.get('error', 'неизвестная ошибка')}"
        return function_tool(call, raw_schema={"name": spec["name"], "description": spec["description"], "parameters": spec["parameters"]})

    return [build(spec) for spec in specs]


async def instructions_via_api(socket_path: str, owner_id: str | None = None, chat_id: str | None = None) -> dict:
    connector = aiohttp.UnixConnector(path=socket_path)
    async with aiohttp.ClientSession(connector=connector, timeout=aiohttp.ClientTimeout(total=15)) as http:
        async with http.get("http://localhost/secretary/instructions", params={"owner_id": owner_id, "chat_id": chat_id} if owner_id and chat_id else {}) as response:
            if response.status != 200:
                raise RuntimeError("Не удалось получить инструкции Помощника владельца")
            body = await response.json()
            if not isinstance(body.get("instructions"), str) or not isinstance(body.get("greeting"), str):
                raise RuntimeError("Неверный формат инструкций Помощника владельца")
            return body


class Assistant(Agent):
    def __init__(self, owner_id: str, instructions: str = SECRETARY_INSTRUCTIONS, greeting: str = "поздоровайся коротко и спроси, чем помочь", tools: list | None = None, runner: BackgroundRunner | None = None, instructions_suffix: str = "", chat_ctx: llm.ChatContext | None = None, chat_id: str | None = None) -> None:
        super().__init__(instructions=instructions + ("\n\n" + instructions_suffix if instructions_suffix else ""), tools=tools or [], chat_ctx=chat_ctx)
        self.owner_id = owner_id
        self.chat_id = chat_id
        self.greeting = greeting
        self.runner = runner or BackgroundRunner()

    async def on_enter(self) -> None:
        self.session.generate_reply(instructions=self.greeting)

    async def create_task(self, context: RunContext, text: str) -> str:
        """Передать полное поручение общему серверному разбору постановки задач.

        Args:
            text: Полный текст поручения со сроком, временем, метками, приоритетом,
                исполнителем и деталями. Не сокращай его до названия.
        """
        async def work() -> str:
            cfg = load_config()
            try:
                result = await create_task_via_api(text, cfg.taskflow_socket_path, self.owner_id, **({"chat_id": self.chat_id} if self.chat_id else {}))
            except (RuntimeError, aiohttp.ClientError, TimeoutError) as exc:
                return f"Не получилось разобрать поручение: {exc}"
            return json.dumps(result, ensure_ascii=False)
        return await self.runner.run("постановка задачи", work)

    async def task_summary(self, context: RunContext, text: str, send_to_chat: bool = False) -> str:
        """Получить фактическую сводку задач любого исполнителя или всех ролей.

        Args:
            text: Полная просьба, включая исполнителя, статусы и период (неделя, месяц, даты).
            send_to_chat: True только если владелец просит прислать сводку в чат.
        """
        async def work() -> str:
            cfg = load_config()
            try:
                result = await summary_via_api(text, cfg.taskflow_socket_path, self.owner_id, send_to_chat, **({"chat_id": self.chat_id} if self.chat_id else {}))
            except (RuntimeError, aiohttp.ClientError, TimeoutError) as exc:
                return f"Не удалось получить сводку: {exc}"
            return json.dumps(result, ensure_ascii=False)
        return await self.runner.run("сводка задач", work)

    async def task_details(self, context: RunContext, text: str) -> str:
        """Всё об одной задаче: состояние, шаги плана и кто их делал, вердикт проверки, интеграция, последние комментарии.

        Args:
            text: Название задачи или слова из него, как их назвал владелец.
        """
        async def work() -> str:
            cfg = load_config()
            try:
                result = await lookup_via_api("task", cfg.taskflow_socket_path, self.owner_id, text, **({"chat_id": self.chat_id} if self.chat_id else {}))
            except (RuntimeError, aiohttp.ClientError, TimeoutError) as exc:
                return f"Не удалось посмотреть задачу: {exc}"
            return json.dumps(result, ensure_ascii=False)
        return await self.runner.run("карточка задачи", work)

    async def send_to_owner_chat(self, context: RunContext, text: str) -> str:
        """Написать владельцу в его чат с Помощником владельца: всё, что он просит прислать текстом.

        Args:
            text: Полный текст сообщения, готовый к чтению.
        """
        async def work() -> str:
            cfg = load_config()
            try:
                result = await lookup_via_api("owner-chat", cfg.taskflow_socket_path, self.owner_id, text, **({"chat_id": self.chat_id} if self.chat_id else {}))
            except (RuntimeError, aiohttp.ClientError, TimeoutError) as exc:
                return f"Не удалось написать в чат: {exc}"
            return json.dumps(result, ensure_ascii=False)
        return await self.runner.run("сообщение в чат", work)

    async def role_load(self, context: RunContext) -> str:
        """Загрузка ролей: чем сейчас занята каждая роль, что в очереди и что заблокировано."""
        async def work() -> str:
            cfg = load_config()
            try:
                result = await lookup_via_api("roles", cfg.taskflow_socket_path, self.owner_id, chat_id=self.chat_id)
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
    chat_id = owner.attributes.get("chat_id", "chat-secretary")
    history = await conversation_via_api(cfg.taskflow_socket_path, owner.identity, chat_id)
    logger.info("голос Помощника владельца: %s", voice)

    session = AgentSession(
        llm=RealtimeModel(
            model="gemini-3.8-live",
            api_key=cfg.gemini_api_key,
            voice=voice,
        ),
    )
    async def write_transcript(item_id: str, role: str, text: str) -> None:
        await transcript_via_api(cfg.taskflow_socket_path, owner.identity, chat_id, ctx.room.name, item_id, role, text)
    recorder = VoiceConversationRecorder(write_transcript)
    ctx.add_shutdown_callback(recorder.close)

    @session.on("conversation_item_added")
    def on_conversation_item(event):
        recorder.record(event.item)

    snapshot = await instructions_via_api(cfg.taskflow_socket_path, owner.identity, chat_id)
    runner = BackgroundRunner()
    runner.session = session
    ctx.add_shutdown_callback(runner.close)
    agent = Assistant(owner_id=owner.identity, instructions=snapshot["instructions"], greeting=("Продолжи разговор из истории чата. Коротко скажи, что голос подключён; не повторяй прежние ответы." if history else snapshot["greeting"]), runner=runner, chat_ctx=context_from_messages(history), chat_id=chat_id, instructions_suffix=gender_instruction(voice) + "\nГолос и переписка — один разговор. Твои реплики сохраняются в исходном чате. Для файлов используй общий инструмент прикрепления к текущему чату; не говори, что файл отправлен без успешного результата инструмента.")
    async def close_tools():
        connector = aiohttp.UnixConnector(path=cfg.taskflow_socket_path)
        try:
            async with aiohttp.ClientSession(connector=connector, timeout=aiohttp.ClientTimeout(total=10)) as http:
                async with http.post("http://localhost/secretary/tools-close", json={"owner_id": owner.identity, "chat_id": chat_id, "session_id": ctx.room.name}) as response:
                    await response.read()
        except (aiohttp.ClientError, TimeoutError):
            logger.warning("Не удалось закрыть ресурсы голосового каталога")
    ctx.add_shutdown_callback(close_tools)
    shared = await shared_tools_via_api(cfg.taskflow_socket_path, owner.identity, runner, chat_id, recorder, agent=agent, session_id=ctx.room.name)
    await agent.update_tools(shared)
    logger.info("Голосовой каталог: %s", ", ".join(tool.id for tool in shared))
    await session.start(agent=agent, room=ctx.room)

    # Тап по анимации на телефоне — перебить Помощника владельца на полуслове.
    @ctx.room.local_participant.register_rpc_method("interrupt")
    async def _interrupt(_data) -> str:
        session.interrupt()
        return "ok"


if __name__ == "__main__":
    load_config()  # падаем рано и явно, не на первом же job
    cli.run_app(server)
