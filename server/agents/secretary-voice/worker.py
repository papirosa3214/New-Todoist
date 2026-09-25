"""Секретарь: голосовой воркер LiveKit. Запуск: см. systemd-юнит
taskflow-secretary-voice.service. Ручной прогон (dev):
  ~/.venvs/secretary-voice/bin/python3 worker.py dev
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass

from dotenv import load_dotenv

from livekit.agents import AgentServer, JobContext, cli

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


server = AgentServer()


@server.rtc_session()
async def entrypoint(ctx: JobContext) -> None:
    ctx.log_context_fields = {"room": ctx.room.name}
    logger.info("secretary-voice: подключаюсь к комнате %s", ctx.room.name)

    @ctx.room.on("participant_connected")
    def _on_participant(participant) -> None:  # noqa: ANN001
        logger.info("secretary-voice: участник подключился: %s", participant.identity)

    # Задача 3 подставит сюда AgentSession с Gemini Live вместо простого
    # логирования — на этом шаге цель ровно одна: подтвердить, что dispatch
    # воркера в комнату реально срабатывает.


if __name__ == "__main__":
    load_config()  # падаем рано и явно, не на первом же job
    cli.run_app(server)
