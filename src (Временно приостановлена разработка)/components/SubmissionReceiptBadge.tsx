// Квитанция о сдаче этапа основным TaskFlow (карточка 8aa62aea, шаг
// receipt_web). Серверный контракт уже есть:
//   GET /api/subtasks/:id/submission-receipt
//   { confirmed, authority, task_id, subtask_id, artifact_id, document_id, confirmed_at }
// см. server/src/lib/submissionReceipt.ts и routes/subtask-artifacts.ts.
//
// Здесь только представление: бейдж под результатом закрытого шага.
// Отличает три состояния строго по контракту, не по тексту агента:
//
//   confirmed=true,  authority=primary → «Сдача подтверждена сервером»
//                                       + время UTC, ссылка на документ.
//
//   confirmed=false, authority=sandbox → QA-копия; сдача здесь не считается.
//                                       Метка «Тестовая копия — сдача не подтверждена».
//
//   confirmed=false, authority=primary → основной сервер не подтвердил
//                                       (например, артефакт submitted, а шаг
//                                       ещё не закрыт done=true). Метка
//                                       «Сдача основным сервером не подтверждена».
//
// document_id — id заметки в user_notes (см. roleResultReport.ts), открывается
// по /notes/:id (NoteEditorScreen). Если его нет (квитанция без отчёта) —
// ссылку не рисуем, только время и ID артефакта.
//
// Цель — закрыть критерий карточки «статус подтверждения отображается
// отдельно от текстовых сообщений агента»: метка стоит под result и не
// зависит от того, что написал исполнитель.
import { BadgeCheck, ShieldAlert, FlaskConical } from "lucide-react";
import { Link } from "react-router-dom";
import type { ApiSubmissionReceipt } from "../api/subtasks";

/** Форматирует ISO-время UTC в короткий «ДД.ММ.ГГ ЧЧ:ММ UTC», без часовых
 *  поясов: receipt.confirmed_at хранится в UTC (см. submissionReceipt.ts). */
function formatUtcLabel(iso: string): string {
  const m = iso.match(
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/,
  );
  if (!m) return iso;
  return `${m[3]}.${m[2]}.${m[1].slice(2)} ${m[4]}:${m[5]} UTC`;
}

export interface SubmissionReceiptBadgeProps {
  /** Квитанция с сервера; null/undefined — нет ответа, ничего не рисуем. */
  receipt: ApiSubmissionReceipt | null | undefined;
  /** На случай ошибки сети — тогда сетевая подсказка в виде тонкой строки,
   *  чтобы владелец понял, почему бейдж пустой. */
  error?: unknown;
  /** Индикатор первичной загрузки — тоже объясняет пустоту. */
  loading?: boolean;
}

export function SubmissionReceiptBadge({
  receipt,
  error,
  loading,
}: SubmissionReceiptBadgeProps) {
  if (loading && !receipt) {
    return (
      <div
        className="tf-meta text-dim mt-1"
        data-testid="submission-receipt-loading"
      >
        Проверяю подтверждение сдачи…
      </div>
    );
  }

  // Сетевая ошибка — бейдж не нашли, но не путать владельца: пусть знает,
  // что квитанцию не удалось прочитать, а не что её нет.
  if (error && !receipt) {
    return (
      <div
        className="tf-meta text-orange mt-1 inline-flex items-center gap-1"
        data-testid="submission-receipt-error"
      >
        <ShieldAlert size={12} />
        Не удалось прочитать квитанцию сдачи
      </div>
    );
  }

  if (!receipt) return null;

  const confirmed = receipt.confirmed === true;
  const authority = receipt.authority;
  const time = receipt.confirmed_at;

  if (confirmed && authority === "primary") {
    return (
      <div
        className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1"
        data-testid="submission-receipt-confirmed"
        data-authority="primary"
      >
        <span className="tf-action text-green inline-flex items-center gap-1">
          <BadgeCheck size={13} />
          Сдача подтверждена сервером
        </span>
        {time && (
          <span className="tf-meta text-sub">
            {formatUtcLabel(time)}
          </span>
        )}
        {receipt.artifact_id && (
          <span
            className="tf-meta text-sub font-mono"
            title="ID артефакта, под которым сервер хранит эту сдачу"
          >
            артефакт {receipt.artifact_id.slice(0, 8)}
          </span>
        )}
        {receipt.document_id && (
          <Link
            to={`/notes/${receipt.document_id}`}
            className="tf-action text-blue tap-fade"
            title="Открыть отчёт роли по этому шагу"
          >
            Отчёт о работе →
          </Link>
        )}
      </div>
    );
  }

  // authority=sandbox всегда вне основной приёмки — отдельный тон,
  // чтобы QA-сценарий сразу читался как «это не та среда».
  if (authority === "sandbox") {
    return (
      <div
        className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1"
        data-testid="submission-receipt-sandbox"
        data-authority="sandbox"
      >
        <span className="tf-action text-orange inline-flex items-center gap-1">
          <FlaskConical size={13} />
          Тестовая QA-копия, сдача здесь не считается
        </span>
        {time && (
          <span className="tf-meta text-sub">
            {formatUtcLabel(time)}
          </span>
        )}
      </div>
    );
  }

  // authority=primary, но confirmed=false. Это как раз окно «артефакт
  // submitted, а done ещё 0», о котором писал аудит карточки — оставляем
  // честную пометку, без ложной радости.
  return (
    <div
      className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1"
      data-testid="submission-receipt-unconfirmed"
      data-authority="primary"
      data-confirmed="false"
    >
      <span className="tf-action text-orange inline-flex items-center gap-1">
        <ShieldAlert size={13} />
        Сдача основным сервером не подтверждена
      </span>
      {time && (
        <span className="tf-meta text-sub">
          {formatUtcLabel(time)}
        </span>
      )}
    </div>
  );
}