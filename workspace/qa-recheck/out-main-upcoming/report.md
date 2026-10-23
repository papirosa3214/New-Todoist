# Отчёт живой проверки
Приложение: http://127.0.0.1:4111 · экран 420×912@2 · chromium
Шагов: 11, упало: 3. Ошибок консоли: 1, pageerror: 0, ответов ≥400: 1.

✅ 1. goto "/upcoming"
✅ 2. wait 2000
✅ 3. snap "planirovanie-nachalo"
   кадр: 01-planirovanie-nachalo.png
   раскладка: замечаний нет
✅ 4. expect_no_text "Экран не смог отрисоваться"
❌ 5. expect_text "Октябрь"
   ошибка: locator.waitFor: Timeout 6000ms exceeded.
   кадр: 02-ошибка-шаг-5.png
   раскладка: замечаний нет
❌ 6. expect_text "QA-проверка"
   ошибка: locator.waitFor: Timeout 6000ms exceeded.
   кадр: 03-ошибка-шаг-6.png
   раскладка: замечаний нет
✅ 7. scroll 600
✅ 8. wait 800
✅ 9. snap "planirovanie-prokrutka"
   кадр: 04-planirovanie-prokrutka.png
   раскладка: замечаний нет
✅ 10. expect_no_text "Экран не смог отрисоваться"
❌ 11. expect_text "QA-проверка"
   ошибка: locator.waitFor: Timeout 6000ms exceeded.
   кадр: 05-ошибка-шаг-11.png
   раскладка: замечаний нет

## Ошибки страницы
- pageerror: нет
- console.error: Failed to load resource: the server responded with a status of 500 (Internal Server Error)
- сеть: 500 GET /src/screens/LabelTasksScreen.tsx

## Финальный экран (06-финал.png)
```

```