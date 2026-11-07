# Видео в голосовом разговоре Помощника

Согласованный сценарий: тот же исходный чат, тот же голосовой LiveKit/Gemini Live AgentSession; iPhone ReplayKit публикует screenShareVideo, аудио продолжает идти существующим микрофонным треком.

Изменения: RoomOptions(video_input=True, participant_identity=owner.identity) при запуске существующего worker; зависимость livekit-agents[google,images]==1.8.3 для JPEG-кодирования. Новые комнаты/роль для кадров не создаются. Секреты и auth не менялись.

Проверки:
- Новый тест реального entrypoint на старом коде: FAIL, отсутствует room_options (видеовход выключен). После правки PASS, проверены видео, аудио и привязка identity/room.
- Синтетический кадр подтвердил отсутствующую Pillow: RED ImportError. После установки Pillow 13.0.0 и исправления fixture на поддерживаемый RTC RGBA: GREEN.
- 24 целевых Python unittest: test_screen_share, test_worker, test_conversation, test_background, test_result_queue — OK.
- Live Gemini test через HTTPS_PROXY штатного voice-сервиса: непрерывный JPEG-поток с кодом 7392, голосовой ответ с output transcription: seven three nine two. Ключи не выводились; экран/микрофон владельца не захватывались. Одиночный кадр до текстового хода не был распознан; непрерывный видеопоток распознан.
- Прямой запрос без штатного proxy дал региональный отказ, это не путь production-сервиса; повтор выполнен с его конфигурацией прокси.
- git diff --check: OK. Изменения Python/requirements, TypeScript не менялся.

iOS: в основном репозитории Мак добавлены ReplayKit extension, App Group, background audio и состояние в существующей Live Activity. Профили приложения/расширения с App Group фактически выданы команде RUD4WAP9DF (LocalProvision=true), signed device build и codesign verification прошли. Установка и пользовательский разговор в фоне не проверены и не заявляются как приёмка.

Выкладка: требуется обновление рабочего дерева сервера и перезапуск только голосового воркера при отсутствии активных разговоров. Сам TaskFlow HTTP-сервер менять и перезапускать для этой правки не требуется.
