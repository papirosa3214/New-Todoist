"""Секретарь: голосовой воркер LiveKit. Запуск: см. systemd-юнит
taskflow-secretary-voice.service. Ручной прогон (dev):
  ~/.venvs/secretary-voice/bin/python3 worker.py dev
"""
from __future__ import annotations

import logging
import os
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
    taskflow_api_base: str
    taskflow_agent_token: str


REQUIRED_VARS = (
    "LIVEKIT_URL",
    "LIVEKIT_API_KEY",
    "LIVEKIT_API_SECRET",
    "GEMINI_API_KEY",
    "TASKFLOW_API_BASE",
    "TASKFLOW_AGENT_TOKEN",
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
        taskflow_api_base=os.environ["TASKFLOW_API_BASE"],
        taskflow_agent_token=os.environ["TASKFLOW_AGENT_TOKEN"],
    )


SECRETARY_INSTRUCTIONS = (
    "Ты — Секретарь, голосовой помощник Максима в TaskFlow. Отвечай кратко "
    "и по-русски. Не используй эмодзи и markdown — тебя слушают, а не читают. "
    "Карточку задачи создавай только по явной просьбе («создай задачу», "
    "«запиши») или когда сам уверен, что это задача; при сомнении — "
    "переспроси коротким вопросом, не создавай молча."
)


async def create_task_via_api(title: str, base_url: str, token: str) -> dict:
    async with aiohttp.ClientSession() as http:
        async with http.post(
            f"{base_url}/api/tasks",
            json={"title": title},
            headers={"Authorization": f"Bearer {token}"},
        ) as resp:
            body = await resp.json()
            if resp.status != 200:
                raise RuntimeError(f"TaskFlow отказал: {body.get('error', resp.status)}")
            return body


class Assistant(Agent):
    def __init__(self) -> None:
        super().__init__(instructions=SECRETARY_INSTRUCTIONS)

    async def on_enter(self) -> None:
        self.session.generate_reply(instructions="поздоровайся коротко и спроси, чем помочь")

    @function_tool
    async def create_task(self, context: RunContext, title: str) -> str:
        """Завести карточку задачи в TaskFlow.

        Вызывай ТОЛЬКО когда владелец явно попросил («создай задачу»,
        «запиши это») или когда абсолютно уверен, что реплика — задача.
        При сомнении сначала переспроси голосом, не вызывай этот инструмент.

        Args:
            title: Короткое название задачи, как оно должно выглядеть в списке.
        """
        cfg = load_config()
        try:
            task = await create_task_via_api(
                title, base_url=cfg.taskflow_api_base, token=cfg.taskflow_agent_token
            )
        except RuntimeError as exc:
            return f"Не получилось завести задачу: {exc}"
        return f"Готово, завёл задачу «{task['title']}»."


server = AgentServer()


@server.rtc_session()
async def entrypoint(ctx: JobContext) -> None:
    ctx.log_context_fields = {"room": ctx.room.name}
    cfg = load_config()

    session = AgentSession(
        llm=RealtimeModel(
            model="gemini-3.8-live",
            api_key=cfg.gemini_api_key,
            voice="Puck",
        ),
    )
    await session.start(agent=Assistant(), room=ctx.room)


if __name__ == "__main__":
    load_config()  # падаем рано и явно, не на первом же job
    cli.run_app(server)
