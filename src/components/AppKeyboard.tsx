import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Keyboard from "react-simple-keyboard";
import "react-simple-keyboard/build/css/index.css";
import { MicOverlay } from "./MicOverlay";
import { useMicRecorder } from "../lib/useMicRecorder";
import { useTranscribeAudio } from "../api/audio";
import { normalizeDictatedText } from "../lib/dictationParser";
import { addDictationLogEntry } from "../lib/dictationLog";
import { queueRecording } from "../lib/dictationArchive";
import { hapticKey } from "../lib/haptics";

// ⚠️ ОТКЛЮЧЕНО 20.08.2026 — В ПРИЛОЖЕНИИ НЕ ИСПОЛЬЗУЕТСЯ.
//
// Владелец: «головника с этой клавиатурой больше, чем преимуществ — то
// печатает, то криво смотрится, то неудобно». Вернулись к системной
// клавиатуре и плавающей кнопке микрофона (components/MicKeyboardBar.tsx).
// Файл оставлен целиком по прямой просьбе («не удаляй, сохрани»): раскладка
// и геометрия здесь выверены попиксельно по скриншоту системной клавиатуры
// iPhone владельца и переделываться заново не должны, если к идее вернутся.
// Подключался через lib/keyboardContext.tsx (тоже отключён) — оттуда и
// начинать, если понадобится.

// ═══════════ СВОЯ ЭКРАННАЯ КЛАВИАТУРА (общая для всего приложения) ═══════════
//
// Вынесено из пробного /kb-demo по ТЗ KEYBOARD-INTEGRATION.md (§3 шаг 1).
// Рендерится ОДИН раз на уровне KeyboardProvider (lib/keyboardContext.tsx),
// а не в каждом поле: иначе при переходе фокуса между полями клавиатура
// размонтировалась бы и монтировалась заново — дёрганье плюс потеря
// состояния раскладки (Shift, цифры).
//
// Системная клавиатура гасится атрибутом inputMode="none" на самом поле.
// Проверено замером на реальном iPhone Air (iOS 26.6) 18.08.2026:
// visualViewport при фокусе не сжался вовсе (инсет 0px), тогда как
// контрольное поле без атрибута дало 413px. Поэтому readonly и своя
// каретка из §3 шага 5 ТЗ НЕ понадобились — поле остаётся обычным
// редактируемым, каретка нативная.
//
// Кнопка микрофона — КЛАВИШЕЙ ВНУТРИ клавиатуры (владелец: «не надо, чтобы
// она висела, надо чтобы она была в клавиатуре»). MicKeyboardBar
// сознательно не переиспользован: он позиционируется от `--kb-height`
// (высота СИСТЕМНОЙ клавиатуры), а её здесь нет — переменная 0, и кнопка
// села бы под панель. Тот компонент остаётся верным для системной
// клавиатуры и не тронут.

// Раскладка снята со скриншота системной клавиатуры владельца. Две вещи,
// которые на глаз не угадываются:
//  1) в русской раскладке iOS в первом ряду ОДИННАДЦАТЬ клавиш, «ъ» в ней
//     нет вовсе (вводится долгим нажатием на «ь»);
//  2) подписи ЗАГЛАВНЫЕ независимо от регистра ввода. Регистр вводимых
//     символов задаётся в onKeyPress, не подписью.
const LAYOUTS = {
  default: [
    "й ц у к е н г ш щ з х",
    "ф ы в а п р о л д ж э",
    "{shift} я ч с м и т ь б ю {bksp}",
    "{numbers} {mic} {space} {enter}",
  ],
  shift: [
    "Й Ц У К Е Н Г Ш Щ З Х",
    "Ф Ы В А П Р О Л Д Ж Э",
    "{shift} Я Ч С М И Т Ь Б Ю {bksp}",
    "{numbers} {mic} {space} {enter}",
  ],
  numbers: [
    "1 2 3 4 5 6 7 8 9 0",
    '- / : ; ( ) ₽ & @ "',
    "{abc} . , ? ! ' + = {bksp}",
    "{abc} {mic} {space} {enter}",
  ],
};

// Системная клавиатура iOS рисует ВСЕ буквы заглавными, а вводит строчные,
// пока не нажат Shift. Раскладка держит строчные (они и попадают в поле), а
// сюда подставляются заглавные подписи — подпись и введённый символ
// разведены, и незачем править регистр после каждого нажатия.
const CAPS_DISPLAY = Object.fromEntries(
  "йцукенгзхшщфывапролджэячсмитьбю"
    .split("")
    .map((ch) => [ch, ch.toUpperCase()]),
);

const DISPLAY = {
  ...CAPS_DISPLAY,
  // Подписи служебных клавиш с иконками — непечатаемый символ, а не текст:
  // рисунок даёт CSS-маска (класс kb-icon, см. index.css), а подпись обязана
  // быть НЕПУСТОЙ, иначе библиотека вернёт сырое «{bksp}» и оно проступит
  // на клавише.
  "{bksp}": " ",
  "{enter}": " ",
  "{shift}": " ",
  // На системной клавиатуре пробел без надписи — только мелкая пометка
  // языка у правого края (её рисует CSS через ::after).
  "{space}": " ",
  "{numbers}": "123",
  "{abc}": "АБВ",
  "{mic}": " ",
};

export interface AppKeyboardProps {
  value: string;
  onChange: (next: string) => void;
  /** Многострочное поле: {enter} вставляет перевод строки, а не закрывает. */
  multiline?: boolean;
  /** Для однострочных: что делать по {enter}. Если не задан — onClose. */
  onEnter?: () => void;
  onClose?: () => void;
  /** Сообщить наружу, каким движком распознали. Показывает это НЕ панель:
      она закрывается вместе с окончанием диктовки, и подпись пропадала
      вместе с ней (владелец 18.08.2026: «клавиатура уже скрытая, никакой
      плашки нет»). Рисует KeyboardProvider — он живёт всё время. */
  onEngineNote?: (note: string | null) => void;
}

export function AppKeyboard({
  value,
  onChange,
  multiline = false,
  onEnter,
  onClose,
  onEngineNote,
}: AppKeyboardProps) {
  const [layoutName, setLayoutName] = useState<keyof typeof LAYOUTS>("default");
  const keyboardRef = useRef<unknown>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Значение держим в ref, чтобы обработчик нажатия всегда видел свежее, не
  // завися от замыкания на момент подписки.
  const valueRef = useRef(value);
  valueRef.current = value;

  const transcribeAudio = useTranscribeAudio();

  const mic = useMicRecorder(async (blob) => {
    try {
      const res = await transcribeAudio.mutateAsync(blob);
      // Аббревиатуры в верхний регистр и заглавная первая буква: small пишет
      // «продлить осаго», «позвонить в втб». Тут, а не в парсере: нормализация
      // нужна ЛЮБОМУ полю, а разбор маркеров — только заголовку задачи.
      const rawText = res.text.trim();
      const clean = normalizeDictatedText(rawText);
      // Журнал (выключен по умолчанию, включается в настройках моделей): пишем
      // текст ОТ МОДЕЛИ и текст после наших правок, чтобы было видно, кто
      // исправил регистр — словарь или сама модель.
      addDictationLogEntry({ engine: res.source, raw: rawText, normalized: clean });
      // Аудио — в очередь на выгрузку в архив на .110. Копия на телефоне
      // держится до подтверждения сервером, поэтому запись не потеряется, даже
      // если сети нет или серверный маршрут ещё не развёрнут.
      void queueRecording({
        blob,
        mime: blob.type || "audio/mp4",
        text: rawText,
        engine: res.source,
      });
      if (clean) {
        // Дописываем в конец, а не в позицию каретки: перемещение каретки
        // внутри строки владельцу не нужно (сказал прямо), а поведение
        // simple-keyboard с вставкой в середину не подтверждено.
        const prev = valueRef.current;
        onChange(prev ? `${prev} ${clean}` : clean);
        // Сообщаем, что в поле легла ДИКТОВКА, а не обычный набор. Нужно для
        // разбора маркеров (дата/проект/приоритет): раньше микрофон был
        // отдельной кнопкой, и TaskFormScreen разбирал текст сразу в своём
        // обработчике записи. С переносом микрофона внутрь клавиатуры тот путь
        // перестал вызываться, и разбор остался только на onBlur — а если сразу
        // нажать «Сохранить», обработчик читает ещё неразобранный заголовок
        // (18.08.2026: «сказал завтра позвонить в банк ВТБ, и срок не
        // выставился»). Событием, а не пропсом: клавиатура не должна знать ни
        // про формы, ни про парсер.
        window.dispatchEvent(new CustomEvent("app-dictation-inserted"));
      }
      onEngineNote?.(
        res.source === "whisper"
          ? "Whisper на устройстве"
          : res.source === "apple"
            ? // Причину даёт плагин: «не скачана» / «ещё грузится» /
              // «не загрузилась» — это разные вещи, и путать их нельзя.
              `диктовка Apple (${res.whisperReason ?? "Whisper недоступен"})`
            : "сервер .110",
      );
    } catch {
      onEngineNote?.("не удалось распознать");
    } finally {
      mic.finish();
    }
  });

  // Высота панели → --app-kb-height, чтобы формы поднялись над ней.
  // Замеряем фактическую, а не считаем из CSS: высота зависит от
  // safe-area-inset-bottom и от строки заметки о движке распознавания,
  // которая появляется и исчезает. ResizeObserver, а не однократный замер,
  // именно из-за этой строки.
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const root = document.documentElement;
    const publish = () => {
      root.style.setProperty("--app-kb-height", `${Math.round(el.offsetHeight)}px`);
      window.dispatchEvent(new Event("app-keyboard-resize"));
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(el);
    return () => {
      observer.disconnect();
      // Закрылась — отступ обязан вернуться к нулю, иначе под формой
      // останется «залипшая» пустота на высоту клавиатуры.
      root.style.setProperty("--app-kb-height", "0px");
      window.dispatchEvent(new Event("app-keyboard-resize"));
    };
  }, []);

  const micElapsedLabel = (() => {
    const totalSec = Math.floor(mic.elapsedMs / 1000);
    const m = String(Math.floor(totalSec / 60)).padStart(2, "0");
    const s = String(totalSec % 60).padStart(2, "0");
    return `${m}:${s}`;
  })();

  // Текст считаем САМИ от пропа value, а внутренний буфер библиотеки не
  // используем вовсе (нет ни onChange, ни input). Иначе пришлось бы держать
  // два источника правды синхронно через setInput — именно там и возникает
  // рассинхрон, когда значение поля меняется извне (диктовка, очистка формы).
  function onKeyPress(button: string) {
    // Каждая клавиша — лёгкий отклик, как у системной клавиатуры iOS
    // (там он включается в «Звук и тактильные сигналы»; своей клавиатуре
    // в WKWebView система его не даёт, делаем сами). Ставится до всех
    // ветвлений: служебные клавиши — {shift}, {bksp}, {mic} — такие же
    // нажатия, и молчать на них было бы заметнее, чем щёлкать.
    hapticKey();
    if (button === "{shift}") {
      setLayoutName((n) => (n === "shift" ? "default" : "shift"));
      return;
    }
    if (button === "{numbers}") {
      setLayoutName("numbers");
      return;
    }
    if (button === "{abc}") {
      setLayoutName("default");
      return;
    }
    if (button === "{mic}") {
      if (mic.state === "idle") {
        // Подпись о движке гасим здесь, а не по таймеру: авто-скрытие через
        // 2.5 с владелец просто не успевал заметить («никакой подписи вообще
        // не видел»). Теперь она висит до следующей диктовки — факт, который
        // можно прочитать спокойно.
        onEngineNote?.(null);
        mic.start();
      }
      return;
    }

    const current = valueRef.current;

    if (button === "{bksp}") {
      onChange(current.slice(0, -1));
      return;
    }
    if (button === "{space}") {
      onChange(`${current} `);
      return;
    }
    if (button === "{enter}") {
      if (multiline) {
        onChange(`${current}\n`);
        return;
      }
      // Однострочное поле: перевод строки бессмыслен — отправляем форму либо
      // просто убираем клавиатуру.
      (onEnter ?? onClose)?.();
      return;
    }

    // Печатаемый символ. Раскладка отдаёт готовый регистр (строчные в
    // default, заглавные в shift), поэтому button вставляется как есть.
    onChange(current + button);

    // После одиночной заглавной возвращаемся в нижний регистр — как ведёт
    // себя системная клавиатура. simple-keyboard сам этого не делает: Shift
    // и CapsLock в его демо намеренно совпадают.
    if (layoutName === "shift") setLayoutName("default");
  }

  const micError =
    mic.error ?? (transcribeAudio.isError ? transcribeAudio.error : null);

  // В портал на document.body: клавиатура обязана лежать выше нижней
  // навигации (z-[35]) и FAB (z-30), а внутри дерева экрана её прижало бы
  // контекстом наложения любого transform/overflow родителя.
  return createPortal(
    <>
      <div
        ref={panelRef}
        // Метка для KeyboardProvider: по ней он опознаёт, что фокус ушёл на
        // клавишу, а не в другое поле, и возвращает его обратно.
        data-app-keyboard=""
        // touch-action: панель не должна давать двойным тапом зум, а выделение
        // текста на клавишах бессмысленно и мешает удержанию.
        style={{
          touchAction: "manipulation",
          WebkitUserSelect: "none",
          userSelect: "none",
        }}
        className="fixed inset-x-0 bottom-0 z-[45]"
      >
        {micError != null && (
          <div className="px-4 pb-1 text-[12px] text-coral bg-[#171717]">
            {typeof micError === "string" ? micError : "Ошибка микрофона"}
          </div>
        )}
        {/* Отступы, фон и все замеренные числа — в CSS (.kb-demo). Класс
            намеренно оставлен прежним: значения выверены попиксельно по
            скриншоту, переименование ради красоты имени того не стоит. */}
        <div className="kb-demo">
          <Keyboard
            keyboardRef={(r) => (keyboardRef.current = r)}
            layout={LAYOUTS}
            layoutName={layoutName}
            display={DISPLAY}
            onKeyPress={onKeyPress}
            // Держит фокус (и каретку) в поле при тапе по клавише: клавиши —
            // настоящие кнопки, без этого каждый тап уводил бы фокус и каретка
            // гасла бы на первом же символе. Одного этого мало — см.
            preventMouseDownDefault
            // Кнопки настоящими button-элементами, а не div — первый совет
            // мейнтейнера по iOS-issue #2739 (тап иногда попадал в соседнюю
            // клавишу). Тут же даёт доступность с клавиатуры.
            useButtonTag
            buttonTheme={[
              {
                class: "kb-key-util",
                buttons: "{numbers} {abc}",
              },
              // Клавиши с иконками: подпись прячется, рисунок даёт CSS-маска.
              {
                class: "kb-icon",
                buttons: "{shift} {bksp} {enter} {mic}",
              },
            ]}
          />
        </div>
      </div>

      {(mic.state === "recording" || mic.state === "processing") && (
        <MicOverlay
          state={mic.state}
          elapsedLabel={micElapsedLabel}
          getTimeDomainData={mic.getTimeDomainData}
          onStop={mic.stop}
        />
      )}
    </>,
    document.body,
  );
}
