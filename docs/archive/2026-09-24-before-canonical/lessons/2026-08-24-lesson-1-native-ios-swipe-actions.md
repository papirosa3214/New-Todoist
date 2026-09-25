# Урок 1: Создание ультраплавного нативного iOS-свайпа действий в WebView (React + CSS + Pointer Events)

Подробное пошаговое руководство по созданию свайпа элементов списка с поведением, неотличимым от нативных приложений Apple (iOS Mail, Заметки, Напоминания).

---

## 🎯 Проблема стандартных библиотек свайпа
Большинство JS-библиотек свайпа для веба работают дергано, конфликтуют с вертикальной прокруткой списка на iPhone, имеют задержку отклика или вызывают ложные срабатывания клика при попытке прокрутить экран.

---

## 🏗️ Архитектура решения

Реализация строится на 4 ключевых принципах:
1. **Низкоуровневые `Pointer Events`** вместо `Touch Events` — мгновенная реакция и захват указателя (`setPointerCapture`).
2. **Аппаратное ускорение через `translate3d`** — анимация сдвига выполняется силами GPU без перерисовки DOM (reflow/repaint).
3. **Фирменная кривая отклика Apple (`cubic-bezier`)** — инерция и пружинящий возврат.
4. **Защита от случайных кликов:** если строка приоткрыта, первый тап закрывает её, а не проваливается в просмотр.

---

## 💻 Код реализации (React / TypeScript)

### Шаг 1. Константы геометрии и анимации
```typescript
// Ширина кнопки действия справа (в пикселях)
const ACTION_W = 84; 

// Порог, после которого строка фиксируется в открытом состоянии (60% ширины)
const SNAP_THRESHOLD = ACTION_W * 0.6;

// Фирменная кривая плавности Apple для доводки и закрытия
const IOS_EASE = "cubic-bezier(0.2, 0.9, 0.28, 1)";
```

---

### Шаг 2. Разметка компонента строки
Контейнер строки имеет `overflow-hidden` и `position: relative`. Кнопка действия лежит **под** сдвигаемым контентом у правого края.

```tsx
export function TaskRow({ task, onClick, onEdit }) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const actionRef = useRef<HTMLButtonElement | null>(null);
  const currentXRef = useRef(0);
  const [revealed, setRevealed] = useState(false);

  // Функция мгновенного перемещения слоя (напрямую через transform для 120 FPS)
  const setRowPosition = (x: number, animated = false) => {
    currentXRef.current = x;
    if (rowRef.current) {
      rowRef.current.style.transition = animated 
        ? `transform 0.28s ${IOS_EASE}` 
        : "none";
      rowRef.current.style.transform = `translate3d(${x}px, 0, 0)`;
    }
    
    // Плавное появление и масштабирование кнопки «Изменить»
    if (actionRef.current) {
      const progress = Math.min(Math.abs(x) / ACTION_W, 1.2);
      actionRef.current.style.pointerEvents = Math.abs(x) >= ACTION_W * 0.7 ? "auto" : "none";
      actionRef.current.style.opacity = String(Math.min(progress, 1));
      actionRef.current.style.transform = `scale(${0.8 + 0.2 * Math.min(progress, 1)})`;
    }
  };
```

---

### Шаг 3. Обработка Pointer Events с распознаванием вертикали/горизонтали

```typescript
  const startXRef = useRef(0);
  const startYRef = useRef(0);
  const isHorizontalRef = useRef<boolean | null>(null);
  const isDraggingRef = useRef(false);

  const onPointerDown = (e: React.PointerEvent) => {
    // Игнорируем мультитач или правую кнопку
    if (e.button !== 0) return;

    startXRef.current = e.clientX;
    startYRef.current = e.clientY;
    isHorizontalRef.current = null;
    isDraggingRef.current = true;

    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);

    const onPointerMove = (ev: PointerEvent) => {
      if (!isDraggingRef.current) return;
      const dx = ev.clientX - startXRef.current;
      const dy = ev.clientY - startYRef.current;

      // Определяем направление жеста на первых 6 пикселях
      if (isHorizontalRef.current === null) {
        if (Math.abs(dx) > 6 || Math.abs(dy) > 6) {
          isHorizontalRef.current = Math.abs(dx) > Math.abs(dy);
        }
      }

      // Если пользователь скроллит страницу вверх/вниз — не мешаем
      if (!isHorizontalRef.current) return;

      // Базовое смещение (с учётом уже открытого состояния)
      const baseOffset = revealed ? -ACTION_W : 0;
      let newX = baseOffset + dx;

      // Ограничиваем свайп только влево (свайп вправо дает мягкое сопротивление)
      if (newX > 0) {
        newX = newX * 0.2; // Эффект натянутой резинки
      } else if (newX < -ACTION_W) {
        // Перетягивание левее ширины кнопки тоже гасится резинкой
        const over = Math.abs(newX) - ACTION_W;
        newX = -(ACTION_W + over * 0.3);
      }

      setRowPosition(newX, false);
    };

    const onPointerUp = (ev: PointerEvent) => {
      isDraggingRef.current = false;
      target.releasePointerCapture(ev.pointerId);
      target.removeEventListener("pointermove", onPointerMove);
      target.removeEventListener("pointerup", onPointerUp);
      target.removeEventListener("pointercancel", onPointerUp);

      if (!isHorizontalRef.current) return;

      const currentX = currentXRef.current;
      // Доводка: если протянули дальше порога — фиксируем открытой, иначе захлопываем
      if (currentX < -SNAP_THRESHOLD) {
        setRevealed(true);
        setRowPosition(-ACTION_W, true);
        // Тактильный виброотклик iOS (Haptics)
        if (window.Capacitor) {
          import("@capacitor/haptics").then(({ Haptics, ImpactStyle }) => {
            Haptics.impact({ style: ImpactStyle.Light }).catch(() => {});
          });
        }
      } else {
        setRevealed(false);
        setRowPosition(0, true);
      }
    };

    target.addEventListener("pointermove", onPointerMove);
    target.addEventListener("pointerup", onPointerUp);
    target.addEventListener("pointercancel", onPointerUp);
  };
```

---

### Шаг 4. Умный клик по строке
```tsx
  return (
    <div className="relative overflow-hidden w-full bg-card rounded-2xl mb-2">
      {/* Кнопка «Изменить», лежащая сзади */}
      <button
        ref={actionRef}
        onClick={(e) => {
          e.stopPropagation();
          onEdit();
          // Автоматически закрываем после нажатия
          setRevealed(false);
          setRowPosition(0, true);
        }}
        className="absolute right-0 top-0 bottom-0 flex flex-col items-center justify-center bg-blue text-white"
        style={{ width: ACTION_W }}
      >
        <Icon name="edit" size={20} />
        <span className="text-[11px] font-semibold mt-0.5">Изменить</span>
      </button>

      {/* Лицевая часть карточки, которая сдвигается */}
      <div
        ref={rowRef}
        onPointerDown={onPointerDown}
        style={{ willChange: "transform" }}
        className="bg-card"
      >
        <div
          onClick={() => {
            // Если строка была приоткрыта — первый клик просто захлопывает её!
            if (revealed) {
              setRevealed(false);
              setRowPosition(0, true);
              return;
            }
            onClick(); // Иначе открываем карточку задачи
          }}
          className="p-4 flex items-center justify-between"
        >
          <span>{task.title}</span>
        </div>
      </div>
    </div>
  );
}
```

---

## 🏆 Результат:
* **Мгновенный отклик 120 FPS** на экранах ProMotion (iPhone 13 Pro–16 Pro).
* Никаких конфликтов с вертикальным скроллом страницы.
* Мягкий отскок при перетягивании и легкий виброотклик при фиксации.
