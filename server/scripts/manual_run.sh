#!/usr/bin/env bash
# Разовый запуск ОДНОГО агента на ОДНОЙ карточке по команде владельца.
# Те же ключи, что у службы-будильника, но ничего не крутится: заход и выход.
# Аргументы прокидываются в trigger.py: --once <id> [--review].
set -euo pipefail
exec /usr/bin/python3 /home/maksim/.claude/vault-run.py \
  --secret TASKFLOW_TOKEN=TASKFLOW_PI_AGENT_TOKEN \
  --secret TASKFLOW_SERVICE_TOKEN=TASKFLOW_PI_AGENT_TOKEN \
  --secret TASKFLOW_AGENT_TOKEN_RESEARCHER=TASKFLOW_AGENT_TOKEN_RESEARCHER \
  --secret TASKFLOW_AGENT_TOKEN_ANALYST=TASKFLOW_AGENT_TOKEN_ANALYST \
  --secret TASKFLOW_AGENT_TOKEN_SYNTHESIZER=TASKFLOW_AGENT_TOKEN_SYNTHESIZER \
  --secret TASKFLOW_AGENT_TOKEN_CRITIC_VERIFIER=TASKFLOW_AGENT_TOKEN_CRITIC_VERIFIER \
  --secret TASKFLOW_AGENT_TOKEN_ARCHITECT=TASKFLOW_AGENT_TOKEN_ARCHITECT \
  --secret TASKFLOW_AGENT_TOKEN_BUILDER=TASKFLOW_AGENT_TOKEN_BUILDER \
  --secret TASKFLOW_AGENT_TOKEN_QA=TASKFLOW_AGENT_TOKEN_QA \
  --secret TASKFLOW_AGENT_TOKEN_DESIGNER=TASKFLOW_AGENT_TOKEN_DESIGNER \
  -- /usr/bin/python3 /home/maksim/Проекты/New-Todoist/server/scripts/trigger.py "$@"
