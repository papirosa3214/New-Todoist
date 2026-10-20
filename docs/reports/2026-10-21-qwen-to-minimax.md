# 21.10.2026 — кто будил Qwen и перевод на MiniMax

## Источник нагрузки

Копия сервера TaskFlow под `tfrole` (PID 1828368/1828390), поднята ролью в 00:36 из worktree
`64af4c85…` со старым кодом (дефолт qwen на `192.168.1.110:11434`). Раз в ~2 мин шлёт `/api/chat`,
Ollama грузит Qwen на CPU. Убивать через `sudo kill` (процесс чужого пользователя).

## Переведено на прокладку :11500 (MiniMax-M3.1-Flash-Preview)

- Hermes: `MNEMOSYNE_LLM_BASE_URL` → `http://localhost:11500/v1`, `MNEMOSYNE_LLM_MODEL` → MiniMax;
  `~/.hermes/config.yaml`, `~/.hermes/.env`, `.env` всех 8 профилей. hermes-gateway/serve перезапущены.
- asr.service: `OLLAMA_URL=http://localhost:11500/api/chat`, `OLLAMA_MODEL=MiniMax-M3.1-Flash-Preview`, перезапущен.
- Копии: `*.bak-minimax-<время>` рядом с каждым файлом.
- Проверка прокладки: `/api/chat` → «Париж», `/v1/chat/completions` → «ок». Диктовка целиком не гонялась.

## Не тронуто

- Ручной Hermes из ssh (PID 2119079, родитель 2116686, с 01:19) — старые настройки, ходит в Qwen. Перезапустить.
- Провайдеры `ollama-local` и `Local (127.0.0.1:11434)` в списке моделей Hermes — сами Qwen не вызывают.
- Эмбеддинги bge-m3 идут в локальную Ollama — так задумано.
