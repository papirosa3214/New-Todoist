import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AppKeyboard } from "../components/AppKeyboard";
import { warmUpWhisper } from "./localAI";
import { flushArchiveQueue } from "./dictationArchive";

// ⚠️ ОТКЛЮЧЕНО 20.08.2026 — ПРОВАЙДЕР НИГДЕ НЕ СМОНТИРОВАН.
//
// Своя экранная клавиатура убрана из приложения по решению владельца, App.tsx
// больше не оборачивает Layout этим провайдером — поля снова получают
// системную клавиатуру. Файл сохранён вместе с components/AppKeyboard.tsx:
// здесь лежит весь нетривиальный слой подключения (перехват по DOM, удержание
// фокуса при тапе по клавише, запись значения через нативный сеттер), и
// восстанавливать его заново по памяти нельзя — см. разбор ниже.
//
// Прогрев Whisper и досылка архива диктовок, которые жили в этом провайдере,
// переехали в components/Layout.tsx — они к клавиатуре отношения не имели.

// ═══════════ ОДНА КЛАВИАТУРА НА ВСЁ ПРИЛОЖЕНИЕ ═══════════
//
// ТЗ KEYBOARD-INTEGRATION.md §3 шаг 2. Клавиатура рендерится один раз здесь,
// на уровне провайдера, а не по экземпляру на поле: иначе при переходе фокуса
// между полями она размонтировалась бы и монтировалась заново — визуальное
// дёрганье плюс сброс раскладки (Shift, цифры).
//
// ═══ Почему делегирование по DOM, а не хук в каждом поле ═══
//
// Первый заход (18.08.2026) подключал поля по одному — хук в TextField и в
// четырёх textarea. На телефоне это провалилось по двум причинам разом:
//
//  1) В проекте 14 «сырых» <input>/<textarea>, написанных мимо TextField
//     (комментарий в задаче, названия проектов и меток, поиск, имя агента,
//     поля в TaskFields) — на них всплывала СИСТЕМНАЯ клавиатура. Подключать
//     их поимённо значит забыть следующее добавленное поле ровно так же.
//
//  2) Даже там, где хук стоял, клавиатура не появлялась. Объект контекста
//     собирался заново на каждом рендере провайдера, поэтому эффект в поле
//     перезапускался, а его cleanup звал forget(id) — и тот сбрасывал активное
//     поле в том же кадре, в котором фокус его выставил. Гонка на нестабильной
//     ссылке; вылечена не мемоизацией, а тем, что регистрации полей больше нет.
//
// Поэтому провайдер работает по DOM:
//  1) проставляет inputmode="none" всем текстовым полям (и следит за новыми
//     через MutationObserver — поля появляются в модалках и списках);
//  2) слушает focusin/focusout на document и по ним показывает клавиатуру.
//
// Атрибут обязан стоять ДО фокуса: если выставить его в обработчике focus,
// системная клавиатура успевает начать выезжать. Отсюда упреждающий обход, а не
// установка по событию.
//
// Провайдер ставится ВНУТРИ RequireAuth (см. App.tsx): на /login и /register он
// не смонтирован вовсе, поля там остаются обычными и получают системную
// клавиатуру — иначе пароль не ввести.

// Типы, которым своя клавиатура не подходит: раскладка принципиально другая
// (цифры, email, дата) либо ввод не текстовый вовсе. Их не трогаем — пусть
// система даёт свою специализированную клавиатуру или пикер.
const SYSTEM_TYPES = new Set([
  "password",
  "email",
  "number",
  "tel",
  "url",
  "date",
  "time",
  "datetime-local",
  "month",
  "week",
  "color",
  "file",
  "range",
  "checkbox",
  "radio",
  "submit",
  "reset",
  "button",
  "image",
  "hidden",
]);

type TextEl = HTMLInputElement | HTMLTextAreaElement;

// Отказ от своей клавиатуры — атрибутом data-system-keyboard на поле или на
// любом родителе. Через DOM, а не через пропсы, потому что и сам перехват идёт
// по DOM: так отказ работает и у «сырых» полей, написанных мимо TextField.
function isOptedOut(el: TextEl): boolean {
  return el.closest("[data-system-keyboard]") !== null;
}

function isOurField(el: EventTarget | null): el is TextEl {
  if (el instanceof HTMLTextAreaElement) return !isOptedOut(el);
  if (el instanceof HTMLInputElement) {
    // el.type отдаёт нормализованный тип (по умолчанию "text"), в отличие от
    // getAttribute("type"), который у поля без атрибута вернёт null.
    return !SYSTEM_TYPES.has(el.type) && !isOptedOut(el);
  }
  return false;
}

// React слушает не onChange DOM-элемента, а всплывающее событие input, и
// значение читает из своего внутреннего дескриптора. Поэтому просто присвоить
// el.value недостаточно — React этого не заметит и при следующем рендере
// вернёт старое значение. Рабочий путь: записать через НАТИВНЫЙ сеттер
// прототипа (минуя переопределённый React-ом) и выстрелить bubbling-событием
// input. Для вызывающего кода это неотличимо от живого ввода, поэтому
// существующие onChange полей работают как есть и править их не пришлось ни в
// одном файле.
function setNativeValue(el: TextEl, next: string) {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, next);
  else el.value = next;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

export function KeyboardProvider({ children }: { children: ReactNode }) {
  const [activeEl, setActiveEl] = useState<TextEl | null>(null);
  // Значение активного поля — в состоянии: именно оно отдаётся клавиатуре и
  // заставляет её перерисоваться при наборе. Читать el.value прямо в рендере
  // нельзя — мутация DOM не вызывает ре-рендер React.
  const [value, setValue] = useState("");
  // Подпись о движке распознавания живёт ЗДЕСЬ, а не в панели: панель
  // закрывается по окончании диктовки, и подпись пропадала вместе с ней.
  // Ставится ПОСЛЕ расшифровки, по фактическому результату — не предсказание:
  // какой движок сработал, до получения текста неизвестно, и откат на сервер
  // тоже виден именно так.
  const [engineNote, setEngineNote] = useState<string | null>(null);
  const closeTimer = useRef<number | null>(null);
  const noteTimer = useRef<number | null>(null);
  // Идёт ли прямо сейчас касание по самой клавиатуре. Нужен именно флаг, а не
  // проверка e.relatedTarget в focusout: на iOS relatedTarget при тапе по
  // кнопке приходит null, и отличить «ушёл на клавишу» от «ушёл вообще» по
  // событию нельзя.
  const touchingKeyboard = useRef(false);
  const clearTouchTimer = useRef<number | null>(null);
  // Прогрев модели распознавания при входе в приложение. Здесь, а не в момент
  // диктовки: загрузка CoreML-модели занимает куда больше трёх секунд, которые
  // отведены на ожидание в плагине, поэтому «ленивая» загрузка означала, что
  // Whisper не успевал никогда.
  useEffect(() => {
    warmUpWhisper();
    // Догоняем то, что не ушло раньше: .110 мог быть недоступен, или серверный
    // маршрут ещё не был развёрнут.
    void flushArchiveQueue();
  }, []);

  useEffect(() => {
    const cancelClose = () => {
      if (closeTimer.current !== null) {
        window.clearTimeout(closeTimer.current);
        closeTimer.current = null;
      }
    };

    // Простановка атрибута. Проверка перед записью обязательна: setAttribute с
    // тем же значением всё равно порождает мутацию, а мутация — новый вызов
    // наблюдателя, то есть лишний круг работы на каждый кадр.
    const mark = (el: Element) => {
      if (isOurField(el) && el.getAttribute("inputmode") !== "none") {
        el.setAttribute("inputmode", "none");
      }
    };
    const prepare = (root: ParentNode) => {
      if (root instanceof Element) mark(root);
      root.querySelectorAll("input, textarea").forEach(mark);
    };

    // Полный обход — ОДИН раз при монтировании.
    prepare(document);

    // Дальше только то, что реально добавилось. Полный querySelectorAll по
    // документу на каждую мутацию был реальной причиной лагов и подвисания при
    // удержании клавиши (18.08.2026): библиотека при удержании рекурсивно
    // повторяет нажатие, каждое нажатие перерисовывает список задач, каждая
    // перерисовка — пачка мутаций, и на каждую шёл обход всего дерева.
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes" && record.target instanceof Element) {
          mark(record.target);
          continue;
        }
        record.addedNodes.forEach((node) => {
          if (node instanceof Element) prepare(node);
        });
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      // Ещё и атрибуты: поле могло получить data-system-keyboard или сменить
      // type уже после вставки в дерево.
      attributes: true,
      attributeFilter: ["type", "data-system-keyboard"],
    });

    const onFocusIn = (e: FocusEvent) => {
      if (!isOurField(e.target)) {
        // Фокус ушёл в поле, которому нужна системная клавиатура (пароль,
        // число) — свою убираем, иначе на экране окажутся обе.
        cancelClose();
        setActiveEl(null);
        return;
      }
      cancelClose();
      setActiveEl(e.target);
      setValue(e.target.value);
    };

    // Тап по клавише физически уводит фокус с поля (клавиши — настоящие
    // кнопки), каретка гаснет и focusout закрывает панель — именно поэтому
    // «начинаю писать, она тут же прячется». preventMouseDownDefault у
    // библиотеки на iOS этого не удерживает. Ловим касание по панели заранее и
    // возвращаем фокус в поле.
    const onPointerDown = (e: Event) => {
      const target = e.target;
      // Новое касание отменяет отложенный сброс от предыдущего.
      if (clearTouchTimer.current !== null) {
        window.clearTimeout(clearTouchTimer.current);
        clearTouchTimer.current = null;
      }
      touchingKeyboard.current =
        target instanceof HTMLElement &&
        target.closest("[data-app-keyboard]") !== null;
    };
    // Сброс флага — отложенный, потому что focusout от этого же тапа приходит
    // позже. Таймер ОБЯЗАН быть отменяемым: при быстром наборе таймер от
    // предыдущей клавиши срабатывал посреди следующего нажатия, флаг падал в
    // false, фокус не возвращался и панель закрывалась. Ровно это и было
    // «печатаю — прячется»: в логе касание по клавише с вПанели=true, а через
    // 65 мс потеря фокуса с вернём=false.
    const onPointerUp = () => {
      if (clearTouchTimer.current !== null) {
        window.clearTimeout(clearTouchTimer.current);
      }
      clearTouchTimer.current = window.setTimeout(() => {
        clearTouchTimer.current = null;
        touchingKeyboard.current = false;
      }, 300);
    };

    const onFocusOut = (e: FocusEvent) => {
      if (!isOurField(e.target)) return;
      if (touchingKeyboard.current) {
        // Фокус вернуть синхронно нельзя — WebKit его тут же снова снимет;
        // ставим в следующий тик, когда обработка тапа завершится.
        const field = e.target;
        window.setTimeout(() => {
          if (document.activeElement !== field) field.focus({ preventScroll: true });
        }, 0);
        return;
      }
      // Отложенно, а не сразу: тап по клавише формально уводит фокус с поля
      // (клавиши — настоящие кнопки, useButtonTag), и мгновенное закрытие
      // убивало бы клавиатуру на первом же нажатии. preventMouseDownDefault у
      // библиотеки фокус удерживает, но на реальном тапе по iOS порядок
      // событий не гарантирован. Если за это время фокус пришёл в другое поле,
      // onFocusIn успеет отменить таймер.
      cancelClose();
      closeTimer.current = window.setTimeout(() => {
        closeTimer.current = null;
        setActiveEl(null);
      }, 180);
    };

    // Поле могло получить фокус ДО того, как этот эффект навесил слушатели:
    // React выполняет эффекты потомков раньше эффектов родителя, а экран
    // поиска фокусирует своё поле через autoFocus (SearchScreen). Тот
    // focusin провайдер физически пропускал, и панель не появлялась вовсе,
    // хотя поле было в фокусе и inputmode=none стоял. Поэтому при монтировании
    // смотрим текущий activeElement, а не ждём только событий.
    if (isOurField(document.activeElement)) {
      setActiveEl(document.activeElement);
      setValue(document.activeElement.value);
    }

    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    // Capture: надо узнать о касании ДО того, как оно уведёт фокус.
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("touchstart", onPointerDown, true);
    document.addEventListener("pointerup", onPointerUp, true);
    document.addEventListener("touchend", onPointerUp, true);

    return () => {
      observer.disconnect();
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("touchstart", onPointerDown, true);
      document.removeEventListener("pointerup", onPointerUp, true);
      document.removeEventListener("touchend", onPointerUp, true);
      if (clearTouchTimer.current !== null) {
        window.clearTimeout(clearTouchTimer.current);
      }
      cancelClose();
    };
  }, []);

  // Подпись гаснет сама. Таймер отменяемый: новая диктовка обнуляет подпись и
  // не должна получить гашение от предыдущей — та же ошибка, что уже была с
  // флагом удержания фокуса.
  const showEngineNote = useCallback((note: string | null) => {
    if (noteTimer.current !== null) {
      window.clearTimeout(noteTimer.current);
      noteTimer.current = null;
    }
    setEngineNote(note);
    if (note !== null) {
      noteTimer.current = window.setTimeout(() => {
        noteTimer.current = null;
        setEngineNote(null);
      }, 10000);
    }
  }, []);

  useEffect(
    () => () => {
      if (noteTimer.current !== null) window.clearTimeout(noteTimer.current);
    },
    [],
  );

  const handleChange = useCallback(
    (next: string) => {
      setValue(next);
      if (activeEl) setNativeValue(activeEl, next);
    },
    [activeEl],
  );

  const close = useCallback(() => {
    activeEl?.blur();
    setActiveEl(null);
  }, [activeEl]);

  // Однострочное поле: {enter} = отправить форму, если поле в форме, иначе
  // просто убрать клавиатуру — тем же поведением, что и системная.
  const handleEnter = useCallback(() => {
    if (!activeEl) return;
    const form = activeEl.closest("form");
    if (form) {
      form.requestSubmit();
      return;
    }
    close();
  }, [activeEl, close]);

  return (
    <>
      {children}
      {activeEl && (
        <AppKeyboard
          value={value}
          onChange={handleChange}
          multiline={activeEl instanceof HTMLTextAreaElement}
          onEnter={handleEnter}
          onClose={close}
          onEngineNote={showEngineNote}
        />
      )}
      {engineNote && (
        // Снизу и само гаснет через 5 с (владелец 18.08.2026: «плавающее
        // окошечко, хер с ним снизу появилось, и потом через секунды пять
        // исчезло»).
        //
        // bottom считается от --kb-inset, а не прибит к нулю: когда панель
        // открыта, инсет равен её высоте, и окошко всплывает НАД клавишами;
        // когда закрыта — инсет 0, и оно садится к низу экрана. Одна формула
        // на оба случая, без отслеживания состояния панели.
        //
        // pointer-events: none — окошко не должно перехватывать касания по
        // тому, что под ним.
        <div
          className="fixed inset-x-0 z-[60] flex justify-center pointer-events-none"
          style={{
            bottom:
              "calc(var(--kb-inset, 0px) + env(safe-area-inset-bottom, 0px) + 12px)",
          }}
        >
          <div className="px-3 py-1 rounded-full bg-card2/95 text-[11px] text-sub">
            Распознано: {engineNote}
          </div>
        </div>
      )}
    </>
  );
}
