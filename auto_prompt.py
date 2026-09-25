with open('server/scripts/trigger.py', 'r') as f:
    content = f.read()

# We need to change the signatures of the prompt functions
import re

content = content.replace(
    'def build_orchestrator_prompt(task: dict, reason: str) -> str:',
    'def build_orchestrator_prompt(task: dict, reason: str, is_claude: bool = False) -> str:'
)

content = content.replace(
    'def build_orchestrator_resume_prompt(task: dict, reason: str) -> str:',
    'def build_orchestrator_resume_prompt(task: dict, reason: str, is_claude: bool = False) -> str:'
)

# Fix the calls
content = content.replace(
    'first = build_orchestrator_prompt(task, reason)',
    'first = build_orchestrator_prompt(task, reason, claude_cli)'
)

content = content.replace(
    'return (build_orchestrator_resume_prompt(fresh, reason) if orchestrator',
    'return (build_orchestrator_resume_prompt(fresh, reason, claude_cli) if orchestrator'
)

# Now inject the if/else logic into build_orchestrator_prompt
old_orch_body = '''    comments = "\\n".join(
        f"  {c.get('user_name')}: {c.get('text')}" for c in (task.get("comments") or [])[-8:]
    )
    return f"""Тебя разбудила доска TaskFlow: {reason}.

От тебя требуется выступить в роли Оркестратора. Твоя задача — не писать'''

new_orch_body = '''    comments = "\\n".join(
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

ВАЖНО: Вся должностная инструкция о том, КАК именно работать с TaskFlow (как бить задачи, как использовать `parent_id`, кто есть кто в команде и как принимать работу), лежит в файле `docs/current/taskflow-orchestrator.md`. 
Если ты забыл регламент — обязательно прочитай этот файл перед тем, как действовать!
"""

    return f"""Тебя разбудила доска TaskFlow: {reason}.

От тебя требуется выступить в роли Оркестратора. Твоя задача — не писать'''

content = content.replace(old_orch_body, new_orch_body)


# Inject if/else into resume prompt
old_resume_body = '''    comments = "\\n".join(
        f"  {c.get('user_name')}: {c.get('text')}"
        for c in (task.get("comments") or [])[-5:]
    )
    return f"""Доска TaskFlow снова зовёт по координационной задаче «{task.get('title')}»: {reason}.

Это та же задача, которую ты уже раздавал в этой сессии — кому что поручено'''

new_resume_body = '''    comments = "\\n".join(
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

Напоминаю: регламент Оркестратора лежит в `docs/current/taskflow-orchestrator.md`.
Проверь статусы дочерних задач. Используй свой сеньорский опыт, чтобы оценить сданный агентами результат. 
Прими работу, помоги с блокером или заверни на доработку.
"""

    return f"""Доска TaskFlow снова зовёт по координационной задаче «{task.get('title')}»: {reason}.

Это та же задача, которую ты уже раздавал в этой сессии — кому что поручено'''

content = content.replace(old_resume_body, new_resume_body)

with open('server/scripts/trigger.py', 'w') as f:
    f.write(content)
