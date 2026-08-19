// ═══════════ ВЛОЖЕНИЕ В ЛЕНТЕ ═══════════
//
// Файл отдаётся сервером только с токеном (GET /api/attachments/:id,
// доступ такой же, как к самой задаче). Значит простым <img src="/api/...">
// картинку не показать: браузер сходит по адресу БЕЗ заголовка
// Authorization и получит 401. Поэтому файл забирается обычным запросом
// (с токеном), из ответа делается локальная ссылка на объект в памяти, и
// уже она отдаётся <img>. Ссылка освобождается при размонтировании, иначе
// каждая открытая карточка оставляла бы за собой удерживаемые байты.
//
// Токен в адрес не выносится сознательно: он утёк бы в историю, логи
// сервера и заголовок Referer — ровно тот класс утечки, от которого в этом
// хозяйстве отдельные правила.
import { useEffect, useState } from "react";
import { api } from "../api/client";
import { Icon } from "./UI";
import type { ApiAttachment } from "../api/types";

// Килобайты/мегабайты — человеку, а не 1048576. Экспортируется: тем же
// видом размер показывается в поле «Файлы» формы (AttachmentsField.tsx).
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

function isImage(mime: string): boolean {
  return mime.startsWith("image/");
}

export function AttachmentView({ attachment }: { attachment: ApiAttachment }) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    // Заранее грузим только картинки — их надо показать. Документ незачем
    // тянуть, пока по нему не нажали: это может быть мегабайты, которые
    // никто не откроет.
    if (!isImage(attachment.mime)) return;
    let url: string | null = null;
    let cancelled = false;
    api
      .getBlob(`/api/attachments/${attachment.id}`)
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setObjectUrl(url);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [attachment.id, attachment.mime]);

  const open = async () => {
    try {
      const blob = await api.getBlob(`/api/attachments/${attachment.id}`);
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
      // Освобождаем не сразу: вкладка ещё читает ссылку в момент открытия.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      setFailed(true);
    }
  };

  if (isImage(attachment.mime) && !failed) {
    return (
      <button
        type="button"
        onClick={open}
        className="block w-full mt-2 rounded-xl overflow-hidden bg-card2"
        aria-label={`Открыть ${attachment.file_name}`}
      >
        {objectUrl ? (
          <img
            src={objectUrl}
            alt={attachment.file_name}
            // max-h ограничивает высоту в ленте: скриншот телефона иначе
            // занял бы весь экран и вытеснил остальные записи.
            className="w-full max-h-[320px] object-contain"
          />
        ) : (
          <div className="h-24 flex items-center justify-center text-[12px] text-dim">
            Загрузка изображения…
          </div>
        )}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={open}
      className="mt-2 w-full flex items-center gap-2 px-3 h-11 rounded-xl bg-card2 text-left"
    >
      <Icon name="paperclip" size={16} className="text-sub shrink-0" />
      <span className="flex-1 min-w-0 truncate text-[13px] text-text">
        {attachment.file_name}
      </span>
      <span className="text-[12px] text-dim shrink-0">
        {formatSize(attachment.size)}
      </span>
    </button>
  );
}
