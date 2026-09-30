"""Секретарь: голосовой воркер LiveKit. Запуск: см. systemd-юнит
taskflow-secretary-voice.service. Ручной прогон (dev):
  ~/.venvs/secretary-voice/bin/python3 worker.py dev
"""
from __future__ import annotations

import logging
import os
import json
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
    def __init__(self, owner_id: str, instructions: str = SECRETARY_INSTRUCTIONS, greeting: str = "поздоровайся коротко и спроси, чем помочь") -> None:
        super().__init__(instructions=instructions)
        self.owner_id = owner_id
        self.greeting = greeting

    async def on_enter(self) -> None:
        self.session.generate_reply(instructions=self.greeting)

    @function_tool
    async def create_task(self, context: RunContext, text: str) -> str:
        """Передать полное поручение общему серверному разбору постановки задач.

        Args:
            text: Полный текст поручения со сроком, временем, метками, приоритетом,
                исполнителем и деталями. Не сокращай его до названия.
        """
        cfg = load_config()
        try:
            result = await create_task_via_api(text, cfg.taskflow_socket_path, self.owner_id)
        except (RuntimeError, aiohttp.ClientError, TimeoutError) as exc:
            return f"Не получилось разобрать поручение: {exc}"
        return json.dumps(result, ensure_ascii=False)


    @function_tool
    async def task_summary(self, context: RunContext, text: str, send_to_chat: bool = False) -> str:
        """Получить фактическую сводку задач любого исполнителя или всех ролей.

        Args:
            text: Полная просьба, включая исполнителя, статусы и период (неделя, месяц, даты).
            send_to_chat: True только если владелец просит прислать сводку в чат.
        """
        cfg = load_config()
        try:
            result = await summary_via_api(text, cfg.taskflow_socket_path, self.owner_id, send_to_chat)
        except (RuntimeError, aiohttp.ClientError, TimeoutError) as exc:
            return f"Не удалось получить сводку: {exc}"
        return json.dumps(result, ensure_ascii=False)


server = AgentServer()


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
    await session.start(agent=Assistant(owner_id=owner.identity, instructions=snapshot["instructions"], greeting=snapshot["greeting"]), room=ctx.room)

    # Тап по анимации на телефоне — перебить Секретаря на полуслове.
    @ctx.room.local_participant.register_rpc_method("interrupt")
    async def _interrupt(_data) -> str:
        session.interrupt()
        return "ok"


if __name__ == "__main__":
    load_config()  # падаем рано и явно, не на первом же job
    cli.run_app(server)
