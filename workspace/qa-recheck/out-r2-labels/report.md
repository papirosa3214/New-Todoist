# Отчёт живой проверки
Приложение: http://127.0.0.1:4104 · экран 420×912@2 · chromium
Шагов: 9, упало: 0. Ошибок консоли: 4, pageerror: 0, ответов ≥400: 4.

✅ 1. goto "/labels"
✅ 2. wait 1500
✅ 3. snap "metki-spisok"
   кадр: 01-metki-spisok.png
   раскладка: замечаний нет
   текст экрана: "Метки\nВажно\nСДЕЛКА\nUX/UI\nПриложение\nДом\nРобота\nIT\nOpus\nSonnet\nHaiku\nFable\nСоздать метку\nЗадача\nСо сроком и шагами\nЗаметка\nЗапись в дневнике\nПроект\nЗадачи и документация\n23\n4"
✅ 4. click "text=\"Важно\""
✅ 5. wait 2000
✅ 6. snap "metka-zadachi"
   кадр: 02-metka-zadachi.png
   раскладка: мельче 44×44: button.mt-0.5.w-[18px] «Отметить выполненной» 18×18; button.mt-0.5.w-[18px] «Отметить выполненной» 18×18; button.mt-0.5.w-[18px] «Отметить выполненной» 18×18; button.mt-0.5.w-[18px] «Отметить выполненной» 18×18; button.mt-0.5.w-[18px] «Отметить выполненной» 18×18; button.mt-0.5.w-[18px] «Отметить выполненной» 18×18; button.mt-0.5.w-[18px] «Отметить выполненной» 18×18
   текст экрана: "Важно\nQA-проверка плана 1792708606\nВажно\n24 окт\n0/1\nQA-проверка часа 1792708606\nВажно\n23 окт\n0/1\nQA-проверка дня 1792708606\nВажно\n23 окт\n0/1\nQA-проверка владельца 1792708606\nВажно\n24 окт\n0/1\nQA-проверка времени 1792708606\nВажно\n23 окт\n0/1\nQA-проверка сегодня 1792708606\nВажно\n23 окт\n0/1\nQA-проверка срока 1792708606\nВажно\n24 окт\n0/1\nЗадача\nСо сроком и шагами\nЗаметка\nЗапись в дневнике\nПроект\nЗадачи и документация\n23\n4"
✅ 7. expect_no_text "Экран не смог отрисоваться"
✅ 8. expect_text "QA-проверка"
✅ 9. expect_text "срока"

## Ошибки страницы
- pageerror: нет
- console.error: Failed to load resource: the server responded with a status of 404 (Not Found)
- console.error: Failed to load resource: the server responded with a status of 404 (Not Found)
- console.error: Failed to load resource: the server responded with a status of 404 (Not Found)
- console.error: Failed to load resource: the server responded with a status of 404 (Not Found)
- сеть: 404 GET /api/avatars/7d875c54-7f21-4af8-9853-b84b6b5483a5.png
- сеть: 404 GET /api/avatars/e3cc4e21-e6b7-40df-bad7-53b206b951d9.png
- сеть: 404 GET /api/avatars/e3cc4e21-e6b7-40df-bad7-53b206b951d9.png
- сеть: 404 GET /api/avatars/7d875c54-7f21-4af8-9853-b84b6b5483a5.png

## Финальный экран (03-финал.png)
```
Важно
QA-проверка плана 1792708606
Важно
24 окт
0/1
QA-проверка часа 1792708606
Важно
23 окт
0/1
QA-проверка дня 1792708606
Важно
23 окт
0/1
QA-проверка владельца 1792708606
Важно
24 окт
0/1
QA-проверка времени 1792708606
Важно
23 окт
0/1
QA-проверка сегодня 1792708606
Важно
23 окт
0/1
QA-проверка срока 1792708606
Важно
24 окт
0/1
Задача
Со сроком и шагами
Заметка
Запись в дневнике
Проект
Задачи и документация
23
4
```