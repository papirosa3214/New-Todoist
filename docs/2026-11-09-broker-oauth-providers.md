# OAuth провайдеров через Secret Broker

Экран «Провайдеры» запускает штатную OAuth-сессию Pi: браузерная ссылка, device code или ручная вставка callback доступны сразу и позволяют завершить вход с телефона.

После успешного входа сервер передаёт access/refresh token и срок действия в Agent Secret Broker. Статус `connected` отправляется клиенту только после успешного сохранения в broker; ошибка broker завершает сессию ошибкой.

Поддерживаются Anthropic, OpenAI Codex и xAI. Токены не включаются в HTTP-ответы, журналы или события сессии.

Проверка: RED отсутствующий модуль handoff; GREEN `test/brokerOAuth.test.ts --maxWorkers=4` (2/2), затем TypeScript compilation.
