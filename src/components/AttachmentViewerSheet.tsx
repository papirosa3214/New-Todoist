// ═══════════ ПРОСМОТР ВЛОЖЕНИЯ ═══════════
//
// Зачем. 26.08.2026 владелец: «настроить возможность скачивания и просмотра
// вложенных файлов». Скачивание в ленте было и работает, а вот ПОСМОТРЕТЬ
// приложенный файл было нечем: единственным действием по строке была
// загрузка на устройство. Для отчёта агента, приложенного к задаче, это
// тупик — телефон скачивает .md и открыть его нечем.
//
// Поэтому текстовые вложения (в том числе markdown, которым агенты и
// отдают отчёты) открываются прямо здесь, в обычной шторке приложения.
// Разметка markdown НЕ рендерится: рендерера в проекте нет, а тянуть
// зависимость ради подсветки заголовков — менять состав проекта ради
// украшения. Текст показывается как есть, с сохранением переносов; для
// отчёта это ровно то, что нужно прочитать.
//
// Картинка тоже показывается здесь — раньше она открывалась отдельной
// вкладкой, и это оставлено на своём месте (см. AttachmentView), но внутри
// шторки её видно вместе с именем и кнопкой сохранения.
//
// PDF и документы в этой версии остаются «скачать»: встроенный просмотр
// каждого формата — отдельная работа, и делать её вслепую, не зная, нужна
// ли она, незачем.
import { useEffect, useState } from "react";
import { api } from "../api/client";
import { Icon, SheetHandle, Loading, ErrorBanner } from "./UI";
import { useBottomSheet } from "../lib/useBottomSheet";
import type { ApiAttachment } from "../api/types";

// Больше этого в текстовом виде не открываем: тянуть в память мегабайты
// ради беглого просмотра незачем, а телефон на таком заметно задумывается.
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

function isText(mime: string): boolean {
  return mime.startsWith("text/");
}

function isImage(mime: string): boolean {
  return mime.startsWith("image/");
}

/** Можно ли показать файл прямо в приложении — или остаётся только скачать. */
export function canPreview(att: ApiAttachment): boolean {
  if (isImage(att.mime)) return true;
  return isText(att.mime) && att.size <= MAX_TEXT_BYTES;
}

export function AttachmentViewerSheet({
  attachment,
  open,
  onClose,
  onDownload,
}: {
  attachment: ApiAttachment;
  open: boolean;
  onClose: () => void;
  onDownload: () => void;
}) {
  const sheet = useBottomSheet({ open, onClose });
  const [text, setText] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let url: string | null = null;
    setLoading(true);
    setError(null);
    api
      .getBlob(`/api/attachments/${attachment.id}`)
      .then(async (blob) => {
        if (cancelled) return;
        if (isImage(attachment.mime)) {
          url = URL.createObjectURL(blob);
          setImageUrl(url);
        } else {
          setText(await blob.text());
        }
      })
      // Ошибку показываем баннером ВНУТРИ шторки. Снаружи её не видно
      // физически: шторка — полноэкранный слой поверх экрана (та же грабля
      // разобрана в DESIGN.md на ReturnToWorkSheet).
      .catch((e) => !cancelled && setError(e))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [open, attachment.id, attachment.mime]);

  if (!sheet.mounted) return null;

  return (
    <div
      // Свайп «назад» не должен уводить экран из-под шторки
      // (useSwipeBack ищет этот атрибут).
      data-overlay
      className="fixed inset-0 z-50 flex flex-col justify-end"
      onClick={onClose}
    >
      <div
        ref={sheet.scrimRef}
        className="absolute inset-0 bg-black"
        style={{ opacity: 0 }}
      />
      <div
        ref={sheet.sheetRef}
        className="relative bg-card rounded-sheet-top px-4 pb-bottom-safe max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <SheetHandle dragProps={sheet.dragProps} />
        <div className="flex items-center justify-between pb-3">
          <button
            onClick={onClose}
            aria-label="Закрыть"
            className="tap-scale w-11 h-11 -ml-2 flex items-center justify-center shrink-0"
          >
            <Icon name="x" size={20} className="text-sub" />
          </button>
          <h3 className="text-[17px] font-semibold text-text truncate px-2">
            {attachment.file_name}
          </h3>
          <button
            onClick={onDownload}
            aria-label={`Скачать ${attachment.file_name}`}
            className="tap-scale w-11 h-11 -mr-2 flex items-center justify-center shrink-0"
          >
            <Icon name="arrowDown" size={20} className="text-text" />
          </button>
        </div>

        <ErrorBanner
          error={error}
          fallback="Не удалось открыть файл"
          variant="block"
          className="mb-3"
        />

        <div className="overflow-y-auto pb-3">
          {loading && <Loading />}
          {!loading && !error && imageUrl && (
            <img
              src={imageUrl}
              alt={attachment.file_name}
              className="w-full rounded-xl object-contain"
            />
          )}
          {!loading && !error && text !== null && (
            // Моноширинный намеренно: в описи и отчётах агентов есть таблицы
            // и колонки, которые в пропорциональном шрифте разъезжаются.
            <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.5] text-text">
              {text}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
