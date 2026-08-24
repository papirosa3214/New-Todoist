// ═══════════ ГОЛОСОВАЯ ДИКТОВКА → ПОЛЯ ЗАДАЧИ ═══════════
//
// Разбирает фразу, надиктованную (Superwhisper на уровне ОС, но парсеру это
// не важно — он получает уже готовый текст из обычного текстового поля) в
// заголовок новой задачи, вида «Позвонить завтра #Работа !срочно», и
// извлекает из неё:
//   - срок (относительные и абсолютные даты),
//   - проект (маркер `#Название`),
//   - приоритет (маркер `!слово`),
// возвращая ОЧИЩЕННЫЙ заголовок без этих маркеров.
//
// Чистая функция, без сети и без React — синхронный regex-разбор, что и
// требовалось (задержка и точка отказа ради даты/приоритета не оправданы).
// Формат маркеров зафиксирован заранее — это не NLP, а извлечение по
// шаблону, поэтому расширять до «понимания» произвольного текста не нужно.
//
// ── ВАЖНАЯ ЛОВУШКА JS-РЕГУЛЯРОК: `\b` НЕ РАБОТАЕТ С КИРИЛЛИЦЕЙ ──
// `\b` определяется через `\w` = `[A-Za-z0-9_]` — кириллические буквы в
// `\w` не входят. Значит, что на границе "пробел → русская буква" ОБЕ
// стороны не-\w, и `\b` там не срабатывает вовсе: `/\bзавтра\b/.test("на
// завтра")` — false. Проверено вручную. Поэтому вместо `\b` везде ниже —
// ручной lookaround по явному классу букв/цифр (см. `wordRe`).

// Символы, которые считаются «частью слова» для самодельной границы —
// латиница + кириллица (включая ё) + цифры. Комбинируется с флагом `i`,
// так что регистр покрывается им, тут перечислены только строчные.
const WORD_CHARS = "a-zа-яё0-9";

// Оборачивает literal-паттерн в lookaround-границы слова — замена `\b`,
// которая действительно работает на кириллице. `pattern` — уже готовый
// фрагмент регулярки (может содержать группы), без своих ^/$ ограничений.
function wordRe(pattern: string): RegExp {
  return new RegExp(
    `(?<![${WORD_CHARS}])(?:${pattern})(?![${WORD_CHARS}])`,
    "iu",
  );
}

// Убирает найденное совпадение из текста по его индексу и схлопывает
// пробелы, которые остались на его месте. Общий хвост и для дат
// (extractDate), и для точечного удаления распознанного `!приоритет` —
// НЕ вызывается, если маркер не распознан (см. разбор приоритета ниже):
// нераспознанное `!слово` должно остаться в заголовке как есть, а не
// молча съедаться вместе с текстом рядом.
function cutMatch(text: string, m: RegExpMatchArray): string {
  const idx = m.index ?? 0;
  return (text.slice(0, idx) + text.slice(idx + m[0].length))
    .replace(/\s{2,}/g, " ")
    .trim();
}

export interface ParsedDictation {
  /** Заголовок без маркеров дат/проекта/приоритета, схлопнутые пробелы убраны. */
  title: string;
  /** "YYYY-MM-DD" или null, если дата в тексте не найдена. */
  dueDate: string | null;
  /** "HH:mm" (например "15:30") или null, если время не найдено. */
  startTime: string | null;
  /** Сырое имя после `#`, как есть (без ведущего `#`) — сверка со списком
   *  проектов остаётся за вызывающим кодом (только он знает список). */
  projectName: string | null;
  /** Сырое имя после `@`, как есть (без ведущего `@`) — сверка со списком
   *  меток остаётся за вызывающим кодом, ровно как и у проекта. */
  labelName: string | null;
  /** 1..4 (см. src/lib/priority.ts — 1 самый срочный) или null. */
  priority: number | null;
}

// ═══════════ Проект: `#Название` ═══════════

// Буквы (латиница+кириллица)/цифры/дефис/подчёркивание — НЕ «всё, что не
// пробел»: если бы маркер жадно захватывал и пунктуацию, «#Работа, срочно»
// вырезало бы вместе с маркером и запятую, склеивая соседние слова.
// Явный класс сам собой останавливается перед знаком препинания — отдельная
// зачистка «хвостовой пунктуации» после этого не нужна.
const MARKER_WORD = `[${WORD_CHARS}_-]+`;
const PROJECT_MARKER_RE = new RegExp(`#(${MARKER_WORD})`, "iu");
const PROJECT_MARKER_RE_G = new RegExp(`#${MARKER_WORD}`, "giu");

// ═══════════ Метка: `@Название` ═══════════
//
// Тот же приём, что у проекта, и тот же класс символов: маркер сам
// останавливается перед пунктуацией, поэтому «@Дом, срочно» не съедает
// запятую. Символ `@` в этом приложении свободен — исполнителя выбирают
// списком, а не упоминанием в тексте, так что путаницы «метка или человек»
// не возникает.
//
// Метка одна, а не список: в форме задачи метки всё равно проставляются
// поштучно, а «@одна @вторая @третья» в надиктованной фразе — это уже не
// быстрый ввод, а разметка. Берётся первая распознанная, остальные маркеры
// из заголовка так же вырезаются (иначе они остались бы мусором в тексте).
const LABEL_MARKER_RE = new RegExp(`@(${MARKER_WORD})`, "iu");
const LABEL_MARKER_RE_G = new RegExp(`@${MARKER_WORD}`, "giu");

// ═══════════ Приоритет: `!слово` ═══════════

const PRIORITY_MARKER_RE = new RegExp(`!(${MARKER_WORD})`, "iu");

// Явные русские слова приоритета + пара латинских синонимов (голосовой ввод
// иногда транслитерирует технический жаргон) + короткие формы `!1`..`!4` и
// `!p1`..`!p4` для тех, кто предпочитает набрать маркер руками, а не
// диктовать. Шкала совпадает с src/lib/priority.ts: 1 — самый срочный.
const PRIORITY_WORDS: Record<number, string[]> = {
  1: [
    "срочно",
    "срочный",
    "срочная",
    "urgent",
    "asap",
    "критично",
    "критический",
    "критическая",
  ],
  2: ["важно", "важный", "важная", "высокий", "высокая", "high", "приоритетно"],
  3: ["средне", "средний", "средняя", "обычно", "обычный", "normal", "medium"],
  4: ["низкий", "низкая", "неважно", "потом", "low", "малозначимо"],
};

function resolvePriorityWord(raw: string): number | null {
  const w = raw.toLowerCase();
  if (/^[1-4]$/.test(w)) return Number(w);
  const pMatch = w.match(/^p([1-4])$/);
  if (pMatch) return Number(pMatch[1]);
  for (const [level, words] of Object.entries(PRIORITY_WORDS)) {
    if (words.includes(w)) return Number(level);
  }
  return null;
}

// ═══════════ Дата ═══════════

// Дни недели: и именительный (после «во»/«в» не требуется склонение для
// части слов), и винительный падеж — «в среду», «в пятницу», «в субботу».
// Индекс — понедельник=0 .. воскресенье=6, чтобы делить с today.getDay()
// через тот же сдвиг, что и остальной код проекта нигде явно не делает, но
// это стандартный ISO-порядок недели.
const WEEKDAY_INDEX: Record<string, number> = {
  понедельник: 0,
  вторник: 1,
  среда: 2,
  среду: 2,
  четверг: 3,
  пятница: 4,
  пятницу: 4,
  суббота: 5,
  субботу: 5,
  воскресенье: 6,
};

// Родительный падеж («15 августа») — основная форма после числа — плюс
// частые сокращения («15 авг», «15 авг.»). Отсортировано по убыванию длины
// один раз ниже (buildMonthAlt), чтобы регулярка пробовала длинный вариант
// раньше короткого — иначе альтернация вида `авг|августа` матчила бы только
// «авг» и оставляла «уста» в хвосте как мусор.
const MONTHS: { index: number; tokens: string[] }[] = [
  { index: 0, tokens: ["января", "янв"] },
  { index: 1, tokens: ["февраля", "февр", "фев"] },
  { index: 2, tokens: ["марта", "мар"] },
  { index: 3, tokens: ["апреля", "апр"] },
  { index: 4, tokens: ["мая", "май"] },
  { index: 5, tokens: ["июня", "июн"] },
  { index: 6, tokens: ["июля", "июл"] },
  { index: 7, tokens: ["августа", "авг"] },
  { index: 8, tokens: ["сентября", "сент", "сен"] },
  { index: 9, tokens: ["октября", "окт"] },
  { index: 10, tokens: ["ноября", "нояб", "ноя"] },
  { index: 11, tokens: ["декабря", "дек"] },
];

function buildMonthAlt(): string {
  return MONTHS.flatMap((m) => m.tokens)
    .sort((a, b) => b.length - a.length)
    .join("|");
}

function findMonthByToken(token: string): number | undefined {
  const t = token.toLowerCase();
  return MONTHS.find((m) => m.tokens.includes(t))?.index;
}

function fmt(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

interface DateExtraction {
  dueDate: string | null;
  rest: string;
}

// Порядок веток важен: «послезавтра» ДО «завтра» (хотя lookaround-граница
// уже сама по себе не даёт «завтра» матчиться внутри «послезавтра» — соседняя
// буква «е» не является границей слова, — порядок оставлен для ясности и
// на случай будущих правок регулярки), относительные — до абсолютных.
function extractDate(text: string, today: Date): DateExtraction {
  let m = text.match(wordRe("послезавтра"));
  if (m) {
    const d = new Date(today);
    d.setDate(d.getDate() + 2);
    return { dueDate: fmt(d), rest: cutMatch(text, m) };
  }

  m = text.match(wordRe("сегодня"));
  if (m) {
    return { dueDate: fmt(today), rest: cutMatch(text, m) };
  }

  m = text.match(wordRe("завтра"));
  if (m) {
    const d = new Date(today);
    d.setDate(d.getDate() + 1);
    return { dueDate: fmt(d), rest: cutMatch(text, m) };
  }

  // «через 2 дня» / «через 5 дней» / «через 1 день» — три формы не делят
  // общий стем («день» ≠ «дн»+«ь», там другая гласная), поэтому явная
  // альтернация целыми словами, а не префикс + окончания.
  m = text.match(wordRe("через\\s+(\\d{1,3})\\s+(?:дней|день|дня)"));
  if (m) {
    const n = parseInt(m[1], 10);
    const d = new Date(today);
    d.setDate(d.getDate() + n);
    return { dueDate: fmt(d), rest: cutMatch(text, m) };
  }

  // «в понедельник» / «во вторник» — предлог ОБЯЗАТЕЛЕН. Без него голое имя
  // дня недели слишком легко оказывается частью обычного текста, не
  // связанного с датой вообще («настроить среду разработки», «купить в
  // пятницу» без «в» стало бы «купить», а «среда» в «настроить среду» без
  // проверки предлога срезала бы половину заголовка) — разрушительно и
  // незаметно, ровно то, чего требует избегать «не ломай ручной ввод».
  m = text.match(
    wordRe(
      "(?:в|во)\\s+(понедельник|вторник|сред[ау]|четверг|пятниц[ау]|суббот[ау]|воскресенье)",
    ),
  );
  if (m) {
    const targetDow = WEEKDAY_INDEX[m[1].toLowerCase()];
    const curDow = (today.getDay() + 6) % 7; // JS: вс=0..сб=6 → пн=0..вс=6
    let delta = targetDow - curDow;
    // «Ближайший будущий» — если сегодня уже искомый день, берём СЛЕДУЮЩИЙ
    // (через неделю), а не сегодня: сознательное решение, см. AGENT-*.md
    // задачи не было, но так буквально сформулировано в ТЗ.
    if (delta <= 0) delta += 7;
    const d = new Date(today);
    d.setDate(d.getDate() + delta);
    return { dueDate: fmt(d), rest: cutMatch(text, m) };
  }

  // «15 августа», «15 авг», «15 авг. 2027», «15 августа 2026»
  {
    const re = new RegExp(
      // `(?:\\s+год[ауе]?)?` — само слово «года» после числа. Без него из
      // «4 сентября 2027 года надо продлить ОСАГО» срок разбирался верно
      // (2027-09-04), но «года» оставалось в заголовке и он начинался с него
      // (18.08.2026, владелец: «у меня текст начинается с года»).
      // `(?:(?:до|к|на)\\s+)?` — предлог перед датой. Без него из «оплатить ЖКХ
      // до 10 сентября» заголовок оставался «оплатить ЖКХ до» с висящим
      // предлогом.
      `(?:(?<![${WORD_CHARS}])(?:до|к|на)\\s+)?(?<![0-9])(\\d{1,2})\\s+(${buildMonthAlt()})[а-яё]*\\.?\\s*(\\d{4}|\\d{2})?(?:\\s+год[ауе]?)?(?![${WORD_CHARS}])`,
      "iu",
    );
    const mm = text.match(re);
    if (mm) {
      const day = parseInt(mm[1], 10);
      const monthIndex = findMonthByToken(mm[2]);
      if (monthIndex !== undefined && day >= 1 && day <= 31) {
        let year = today.getFullYear();
        const explicitYear = !!mm[3];
        if (explicitYear) {
          year =
            mm[3].length === 2
              ? 2000 + parseInt(mm[3], 10)
              : parseInt(mm[3], 10);
        }
        let d = new Date(year, monthIndex, day);
        // Без явного года и дата уже в прошлом — считаем, что речь про
        // следующий год (типично для «15 августа», сказанного в сентябре).
        if (!explicitYear && d < today) d = new Date(year + 1, monthIndex, day);
        return { dueDate: fmt(d), rest: cutMatch(text, mm) };
      }
    }
  }

  // «15.08», «15.08.2026», «15.08.26»
  {
    const re = /(?<![0-9.])(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?(?![0-9.])/u;
    const mm = text.match(re);
    if (mm) {
      const day = parseInt(mm[1], 10);
      const month = parseInt(mm[2], 10);
      if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
        let year = today.getFullYear();
        const explicitYear = !!mm[3];
        if (explicitYear) {
          year =
            mm[3].length === 2
              ? 2000 + parseInt(mm[3], 10)
              : parseInt(mm[3], 10);
        }
        let d = new Date(year, month - 1, day);
        if (!explicitYear && d < today) d = new Date(year + 1, month - 1, day);
        return { dueDate: fmt(d), rest: cutMatch(text, mm) };
      }
    }
  }

  return { dueDate: null, rest: text };
}

interface TimeExtraction {
  startTime: string | null;
  rest: string;
}

function extractTime(text: string): TimeExtraction {
  // 1. "в 15:30", "в 15.30", "к 9:45", "на 18:00", "15:30"
  {
    const re = /(?:(?<![a-zа-яё0-9])(?:в|во|к|на)\s+)?(?<![0-9:])(\d{1,2})[:.](\d{2})(?![0-9:])/iu;
    const m = text.match(re);
    if (m) {
      const hour = parseInt(m[1], 10);
      const minute = parseInt(m[2], 10);
      if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
        const timeStr = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
        return { startTime: timeStr, rest: cutMatch(text, m) };
      }
    }
  }

  // 2. "в 5 вечера", "в 10 утра", "в 3 часа дня", "в 12 ночи", "в 12 дня"
  {
    const re = /(?:(?<![a-zа-яё0-9])(?:в|во|к|на)\s+)?(?<![0-9])(\d{1,2})\s*(?:часов|часа|ч)?\s*(вечера|ночи|дня|утра)(?![a-zа-яё0-9])/iu;
    const m = text.match(re);
    if (m) {
      let hour = parseInt(m[1], 10);
      const period = m[2].toLowerCase();
      if (hour >= 1 && hour <= 12) {
        if (period === "вечера" && hour < 12) hour += 12;
        else if (period === "ночи" && hour === 12) hour = 0;
        else if (period === "дня" && hour < 12) hour += 12;
        else if (period === "утра" && hour === 12) hour = 0;
        const timeStr = `${String(hour).padStart(2, "0")}:00`;
        return { startTime: timeStr, rest: cutMatch(text, m) };
      }
    }
  }

  // 3. "в 18 часов", "в 14 ч", "к 20 часам"
  {
    const re = /(?<![a-zа-яё0-9])(?:в|во|к|на)\s+(\d{1,2})\s*(?:часов|часа|часам|ч)(?![a-zа-яё0-9])/iu;
    const m = text.match(re);
    if (m) {
      const hour = parseInt(m[1], 10);
      if (hour >= 0 && hour <= 23) {
        const timeStr = `${String(hour).padStart(2, "0")}:00`;
        return { startTime: timeStr, rest: cutMatch(text, m) };
      }
    }
  }

  return { startTime: null, rest: text };
}

// ═══════════ Точка входа ═══════════

// `now` — только для тестируемости (фиксированная «сегодня» вместо
// системных часов); в UI вызывается без второго аргумента.
export function parseDictation(
  rawText: string,
  now: Date = new Date(),
): ParsedDictation {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  let text = rawText;

  let projectName: string | null = null;
  const projectMatch = text.match(PROJECT_MARKER_RE);
  if (projectMatch) projectName = projectMatch[1];
  text = text.replace(PROJECT_MARKER_RE_G, "");

  let labelName: string | null = null;
  const labelMatch = text.match(LABEL_MARKER_RE);
  if (labelMatch) labelName = labelMatch[1];
  text = text.replace(LABEL_MARKER_RE_G, "");

  let priority: number | null = null;
  const priorityMatch = text.match(PRIORITY_MARKER_RE);
  if (priorityMatch) {
    priority = resolvePriorityWord(priorityMatch[1]);
    if (priority !== null) text = cutMatch(text, priorityMatch);
  }

  const { dueDate, rest: afterDate } = extractDate(text, today);
  text = afterDate;

  const { startTime, rest: afterTime } = extractTime(text);
  text = afterTime;

  // Финальная зачистка: схлопнуть пробелы, подтянуть пунктуацию, убрать
  // осиротевшие знаки препинания по краям, оставшиеся на месте вырезанных
  // маркеров («Позвонить, завтра» → «Позвонить, » → «Позвонить»).
  text = text
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/^[\s,.;:]+|[\s,.;:]+$/g, "")
    .trim();

  return { title: text, dueDate, startTime, projectName, labelName, priority };
}

// ═══════════ Кнопка микрофона: вставка распознанного текста ═══════════

// Распознанный ASR текст добавляется к уже введённому, а не заменяет его —
// та же логика, что и у обычного набора текста: несколько нажатий кнопки
// подряд («Купить молоко» + «завтра») копятся в одну фразу, а не стирают
// предыдущую попытку. Пустой текущий заголовок — просто подставляем текст
// без склейки (без ведущего пробела).
export function combineDictatedText(current: string, incoming: string): string {
  const trimmedIncoming = incoming.trim();
  if (!trimmedIncoming) return current;
  const trimmedCurrent = current.trim();
  return trimmedCurrent
    ? `${trimmedCurrent} ${trimmedIncoming}`
    : trimmedIncoming;
}

// Сверка сырого `#Имя` со списком реальных проектов пользователя —
// регистронезависимо, по обрезанным пробелам. Вынесено отдельной чистой
// функцией ради юнит-теста без React; в форме проект просто не
// проставляется, если совпадения нет (никакого автосоздания проекта —
// молчаливое создание нового проекта из опечатки было бы хуже, чем просто
// не поставить его).
export function findProjectByName<T extends { id: string; name: string }>(
  projects: T[],
  name: string | null,
): T | undefined {
  if (!name) return undefined;
  const target = name.trim().toLowerCase();
  return projects.find((p) => p.name.trim().toLowerCase() === target);
}

// ═══════════ НОРМАЛИЗАЦИЯ НАДИКТОВАННОГО ТЕКСТА ═══════════
//
// Whisper на модели small пишет аббревиатуры строчными: «продлить осаго»,
// «позвонить в втб» (18.08.2026, владелец: «ОСАГО все маленькими буквами»).
// На large-v3-turbo такого почти нет, но платить за это 632 МБ и минуты
// прогрева ради регистра — несоразмерно, поэтому чиним словарём.
//
// Список намеренно КОРОТКИЙ и только из того, что реально диктуется в задачах:
// раздувать его до справочника аббревиатур смысла нет — каждая лишняя запись
// это риск испортить обычное слово. Регистр сравнения игнорируется, границы
// слова — тем же lookaround, что и везде здесь (\b с кириллицей не работает,
// см. шапку файла).
const ACRONYMS = [
  "ОСАГО",
  "КАСКО",
  "ВТБ",
  "ИНН",
  "КПП",
  "НДС",
  "ГИБДД",
  "МФЦ",
  "ЖКХ",
  "ТСЖ",
  "ДМС",
  "ПТС",
  "СТС",
  "ЕГРН",
  "ФНС",
];

/**
 * Приводит надиктованный текст к читаемому виду: известные аббревиатуры в
 * верхний регистр, первая буква фразы заглавная.
 *
 * Применяется к тексту ИЗ РАСПОЗНАВАНИЯ, до разбора маркеров: маркеры
 * (`#Проект`, `!приоритет`, даты) регистром не задаются, так что порядок
 * безопасен.
 */
export function capitalizeFirst(text: string): string {
  return text.replace(/^(\s*)(\p{Ll})/u, (_, space, ch) => space + ch.toUpperCase());
}

export function normalizeDictatedText(text: string): string {
  let out = text;
  for (const acronym of ACRONYMS) {
    out = out.replace(
      new RegExp(wordRe(acronym).source, "gi"),
      (match) => match.replace(new RegExp(acronym, "i"), acronym),
    );
  }
  // Первая буква — заглавная. Только первая: остальное трогать нельзя, иначе
  // пострадают имена и те же аббревиатуры.
  return capitalizeFirst(out);
}
