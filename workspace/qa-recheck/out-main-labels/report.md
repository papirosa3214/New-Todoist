# Отчёт живой проверки
Приложение: http://127.0.0.1:4111 · экран 420×912@2 · chromium
Шагов: 9, упало: 3. Ошибок консоли: 2, pageerror: 0, ответов ≥400: 2.

✅ 1. goto "/labels"
✅ 2. wait 1500
✅ 3. snap "metki-spisok"
   кадр: 01-metki-spisok.png
   раскладка: замечаний нет
❌ 4. click "text=\"Важно\""
   ошибка: page.click: Timeout 8000ms exceeded.
   кадр: 02-ошибка-шаг-4.png
   раскладка: замечаний нет
✅ 5. wait 2000
✅ 6. snap "metka-zadachi"
   кадр: 03-metka-zadachi.png
   раскладка: замечаний нет
✅ 7. expect_no_text "Экран не смог отрисоваться"
❌ 8. expect_text "QA-проверка"
   ошибка: locator.waitFor: Timeout 6000ms exceeded.
   кадр: 04-ошибка-шаг-8.png
   раскладка: замечаний нет
❌ 9. expect_text "срока"
   ошибка: locator.waitFor: Timeout 6000ms exceeded.
   кадр: 05-ошибка-шаг-9.png
   раскладка: замечаний нет

## Ошибки страницы
- pageerror: нет
- console.error: Failed to load resource: the server responded with a status of 500 (Internal Server Error)
- console.error: Failed to load resource: the server responded with a status of 500 (Internal Server Error)
- сеть: 500 GET /src/screens/LabelTasksScreen.tsx
- сеть: 500 GET /src/screens/LabelTasksScreen.tsx

## Финальный экран (06-финал.png)
```

```