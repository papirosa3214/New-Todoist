// ═══════════ ФАЙЛЫ ЗАДАЧИ — поле формы ═══════════
//
// Просьба Максима 19.08.2026: «чтобы в заметках я уже изначально мог
// прикреплять скриншоты и документы». До этого вложения существовали только
// в ленте — комментарием, то есть уже ПОСЛЕ того, как задача заведена.
//
// Поле работает в двух режимах, потому что у файла обязан быть хозяин:
//
//   • правка (`taskId` есть) — файл уходит на сервер сразу при выборе, к
//     существующей задаче, и список берётся из самой задачи;
//   • создание (`taskId` нет) — задачи ещё не существует, грузить некуда:
//     выбранные файлы копятся в состоянии формы (`files`) и заливаются
//     после создания, когда идентификатор наконец появился (см.
//     handleSave в TaskFormScreen).
//
// Черновой вариант «грузить сразу, привязать потом» отвергнут: отдача файла
// (GET /api/attachments/:id) проверяет права ЧЕРЕЗ задачу, и вложение без
// task_id нельзя было бы ни показать, ни открыть.
import { useRef, useState } from "react";
import { Icon, ErrorBanner } from "./UI";
import { formatSize } from "./AttachmentView";
import { useUploadTaskAttachment, useDeleteAttachment } from "../api/attachments";
import type { ApiAttachment } from "../api/types";

// Тот же список, что у скрепки в ленте (TaskDetailScreen) — один набор на
// всё приложение, чтобы «в комментарий можно, а в задачу нельзя» не
// случилось.
export const ATTACH_ACCEPT =
  "image/*,application/pdf,text/plain,.doc,.docx,.odt,.ods,.xlsx";

// Зеркало серверных ограничений (server/src/routes/attachments.ts).
// Дублирование здесь осознанное: при СОЗДАНИИ задачи файл уходит на сервер
// уже после того, как задача заведена, и без этой проверки про «слишком
// большой файл» человек узнавал бы, когда отменять поздно.
const MAX_SIZE = 15 * 1024 * 1024;
const ALLOWED_MIME = [
  /^image\//,
  /^application\/pdf$/,
  /^text\/plain$/,
  /^application\/msword$/,
  /^application\/vnd\.openxmlformats-officedocument\./,
  /^application\/vnd\.oasis\.opendocument\./,
];

/** Почему файл не годится — или null, если годится. */
function rejectReason(file: File): string | null {
  if (file.size > MAX_SIZE) {
    return `«${file.name}» больше 15 МБ — столько сервер не принимает`;
  }
  // Пустой type — браузер не опознал файл; сервер такой отвергнет по
  // Content-Type, лучше сказать это сразу и здесь.
  if (!file.type || !ALLOWED_MIME.some((re) => re.test(file.type))) {
    return `«${file.name}» — такие файлы не принимаем`;
  }
  return null;
}

function isImage(mime: string): boolean {
  return mime.startsWith("image/");
}

/** Одна строка списка: иконка, имя, размер, крестик. */
function FileRow({
  name,
  mime,
  size,
  busy,
  onRemove,
}: {
  name: string;
  mime: string;
  size: number;
  busy?: boolean;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-center gap-2 px-3 h-11 rounded-xl bg-card">
      <Icon
        name={isImage(mime) ? "image" : "paperclip"}
        size={14}
        className="text-sub shrink-0"
      />
      <span className="flex-1 min-w-0 truncate text-[13px] text-text">
        {name}
      </span>
      <span className="text-[12px] text-dim shrink-0">{formatSize(size)}</span>
      <button
        type="button"
        onClick={onRemove}
        disabled={busy}
        aria-label={`Убрать ${name}`}
        className="w-9 h-9 -mr-2 flex items-center justify-center text-dim disabled:opacity-40"
      >
        <Icon name="x" size={16} />
      </button>
    </div>
  );
}

export function AttachmentsField({
  taskId,
  saved = [],
  files,
  onFilesChange,
}: {
  /** Есть — правка существующей задачи, файлы уходят на сервер сразу. */
  taskId?: string;
  /** Уже приложенные к задаче (только в режиме правки). */
  saved?: ApiAttachment[];
  /** Выбранные, но ещё не загруженные — режим создания. */
  files: File[];
  onFilesChange: (files: File[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  // Хук вызывается всегда — правила хуков не допускают условного вызова.
  // В режиме создания taskId пустой, но и mutateAsync тогда не дёргается:
  // ветка ниже кладёт файлы в состояние формы.
  const upload = useUploadTaskAttachment(taskId ?? "");
  const remove = useDeleteAttachment();

  const handlePick = async (list: FileList | null) => {
    setLocalError(null);
    // Сброс значения — иначе повторный выбор того же файла не даст события.
    const chosen = list ? Array.from(list) : [];
    if (inputRef.current) inputRef.current.value = "";
    if (!chosen.length) return;

    const ok: File[] = [];
    for (const f of chosen) {
      const reason = rejectReason(f);
      if (reason) {
        setLocalError(reason);
        break;
      }
      ok.push(f);
    }
    if (!ok.length) return;

    if (!taskId) {
      onFilesChange([...files, ...ok]);
      return;
    }

    for (const f of ok) {
      try {
        await upload.mutateAsync(f);
      } catch {
        // Причину показывает ErrorBanner ниже (upload.error) — это ответ
        // сервера, а не сбой: файл мог не пройти по типу или размеру.
        break;
      }
    }
  };

  const handleRemoveSaved = async (id: string) => {
    try {
      await remove.mutateAsync(id);
    } catch {
      // Ошибку покажет ErrorBanner; список обновится инвалидацией кэша.
    }
  };

  return (
    <>
      {/* Тот же лейбл-заголовок секции, что у «Заметка» и «Подзадачи»
          (17px, text-sub, font-semibold) — см. DESIGN.md §6. */}
      <div className="text-[17px] text-sub font-semibold mb-2">Файлы</div>

      {(saved.length > 0 || files.length > 0) && (
        <div className="flex flex-col gap-1 mb-2">
          {saved.map((att) => (
            <FileRow
              key={att.id}
              name={att.file_name}
              mime={att.mime}
              size={att.size}
              busy={remove.isPending}
              onRemove={() => handleRemoveSaved(att.id)}
            />
          ))}
          {files.map((f, i) => (
            <FileRow
              // Имя+размер+позиция: два одноимённых файла подряд иначе
              // делили бы ключ, и React путал бы строки при удалении.
              key={`${f.name}-${f.size}-${i}`}
              name={f.name}
              mime={f.type}
              size={f.size}
              onRemove={() => onFilesChange(files.filter((_, j) => j !== i))}
            />
          ))}
        </div>
      )}

      <ErrorBanner
        error={localError}
        variant="block"
        className="mb-2"
      />
      <ErrorBanner
        error={upload.error}
        fallback="Не удалось приложить файл"
        variant="block"
        className="mb-2"
      />

      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ATTACH_ACCEPT}
        onChange={(e) => handlePick(e.target.files)}
        className="hidden"
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={upload.isPending}
        className="w-full flex items-center gap-2 px-3 h-11 rounded-xl bg-card mb-4 active:opacity-70 disabled:opacity-50"
      >
        <Icon name="paperclip" size={14} className="text-sub shrink-0" />
        <span className="text-[13px] text-sub">
          {upload.isPending ? "Загружаю…" : "Прикрепить файл"}
        </span>
      </button>
    </>
  );
}
