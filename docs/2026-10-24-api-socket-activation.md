# TaskFlow API: отказы Kuma при выкладке, 24.10.2026

192.168.1.110 — LAN-адрес сервера, 3001 — API. Kuma зафиксировала ECONNREFUSED в 08:59:32, 10:07:32 и 11:31:32. Каждому событию соответствует restart taskflow-server из deploy-when-idle (выкладки 82c8f4db, 70ec3a7b, c5df666f). В 02:56 также зафиксирован управляемый перезапуск, инициатор этого рестарта не установлен. Падения процесса по исключению этими записями не подтверждаются.

Добавлена поддержка systemd socket activation. taskflow-server.socket держит порт 3001, процесс Fastify принимает fd 3 только при LISTEN_PID текущего процесса и LISTEN_FDS=1. Обычный запуск без systemd сохраняется. Шаблоны юнитов: server/scripts/systemd/. Живые юниты: ~/.config/systemd/user/taskflow-server.socket и taskflow-server.service.d/93-socket-activation.conf. Сокет включён в sockets.target.

Unit-проверка прежнего поведения: 2 из 4 тестов падают; после исправления 4/4 проходят. tsc --noEmit и сборка dist прошли. На отдельном порту restart с задержкой запуска 2с: 12/12 HTTP 200. На живом API при пустой очереди ролей и чатов: PID 2447896 → 2450879, 20/20 HTTP 200, попавший в restart запрос ждал 2.087с. Результат на .110: ~/infra-changes/20261024-taskflow-api-socket/live-restart-check.json. Перед применением снята SQLite backup в той же папке.

Это защищает новые соединения от ECONNREFUSED во время коротких рестартов. Уже открытые WebSocket/HTTP-соединения могут прерываться, а при долгом старте клиентский timeout остаётся возможен. Сокет нельзя останавливать при обычной выкладке: перезапускать только service.

Отдельный отказ Web в 05:07:46: лог Vite фиксирует EACCES при очистке node_modules/.vite/deps после изменения конфигурации, затем ручной restart в 05:08:29. Сейчас cache принадлежит maksim, HTTPS :5180 возвращает 200. Код веб-клиента не изменялся; повторное возникновение EACCES не воспроизводилось.

Откат: остановить service и socket, убрать 93-socket-activation.conf, отключить socket, daemon-reload, запустить service; код автоматически возвращается к port/host без LISTEN_PID.
