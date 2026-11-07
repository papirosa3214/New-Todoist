1. NeMo Guardrails (NVIDIA) — Colang-рельсы на естественном языке: «X — это Y», «когда Z, отвечай W». Где: и до модели (входной поток — topical/jailbreak rails), и после (fact-checking и safety rails). При срабатывании переписывает ответ или возвращает заранее заданную fallback-фразу, не блокирует процесс жёстко. Источник: https://github.com/NVIDIA/NeMo-Guardrails

2. Guardrails AI — оборачивает модель в Pydantic-схему. Где: вокруг LLM. Что: регулярки, semantic similarity, опционально OpenAI Moderation и fact-check через RAG. При fail: ReAsk модели с указанием ошибки валидации; можно эскалировать на человека. Источник: https://github.com/guardrails-ai/guardrails

3. Llama Guard 3 (Meta) — классификатор safe/unsafe по 14 категориям. Где: после основной модели, как второй проход. Возвращает safe/unsafe Sx по каждой категории; вызывающий код блокирует или переписывает ответ. Источник: https://huggingface.co/meta-llama/Llama-Guard-3-8B

4. Claude Code hooks (PreToolUse / PostToolUse) — пользовательский код между моделью и любым инструментом. Где: до и после каждого tool-call агента. Что проверяет: всё, что может запустить shell/Python — allowlist путей, сканер секретов, JSON-schema на входе/выходе. exit 2 блокирует вызов; stdout → feedback модели; JSON-decision → allow/deny/ask. Источник: https://docs.claude.com/en/docs/claude-code/hooks

5. gitleaks (pre-commit / pre-tool-use) — regex + entropy на секретоподобные строки. Где: до действия (коммит, запись файла через хук). При срабатывании блокирует коммит/запись, печатает путь и маску. Источник: https://github.com/gitleaks/gitleaks

6. Outlines / Instructor (structured output) — генерация по грамматике: JSON-schema, Pydantic-схема или CFG. Где: после модели, перед downstream-парсером. При невалидном выходе — повторный запрос или ReAsk; на выходе гарантированно валидный объект. Источники: https://github.com/outlines-dev/outlines и https://github.com/567-labs/instructor

Приём по OpenAI Moderation выкинул намеренно: страница https://platform.openai.com/docs/guides/moderation отдаёт 403 с CDN даже с User-Agent: Mozilla/5.0.