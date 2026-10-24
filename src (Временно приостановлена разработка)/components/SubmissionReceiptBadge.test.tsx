// Юнит-тесты бейджа квитанции сдачи. Закрывает пункт карточки 8aa62aea
// (receipt_web): «статус подтверждения отображается отдельно от текстовых
// сообщений агента». Контракт не дублируем: бейдж только визуализирует
// ответ серверного /api/subtasks/:id/submission-receipt, никакой своей
// логики «подтверждено/нет» в нём нет.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import {
  SubmissionReceiptBadge,
  type SubmissionReceiptBadgeProps,
} from "./SubmissionReceiptBadge";
import type { ApiSubmissionReceipt } from "../api/subtasks";

function render(props: SubmissionReceiptBadgeProps) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <SubmissionReceiptBadge {...props} />
    </MemoryRouter>,
  );
}

const baseReceipt: ApiSubmissionReceipt = {
  confirmed: true,
  authority: "primary",
  task_id: "t1",
  subtask_id: "s1",
  artifact_id: "sav_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  document_id: "artifact_sav_aaaaaaaa",
  confirmed_at: "2026-10-09T12:34:56Z",
};

describe("<SubmissionReceiptBadge>", () => {
  it("не рисует ничего без квитанции", () => {
    expect(render({ receipt: null })).toBe("");
    expect(render({ receipt: undefined })).toBe("");
  });

  it("primary + confirmed показывает бейдж, время UTC и ссылку на документ", () => {
    const html = render({ receipt: baseReceipt });
    expect(html).toContain("Сдача подтверждена сервером");
    expect(html).toContain("09.10.26 12:34 UTC");
    expect(html).toContain("артефакт sav_aaaa");
    expect(html).toContain('href="/notes/artifact_sav_aaaaaaaa"');
    expect(html).toContain('data-authority="primary"');
    expect(html).toContain('data-testid="submission-receipt-confirmed"');
  });

  it("authority=sandbox рисует отдельный QA-бейдж, ссылку на отчёт НЕ показывает", () => {
    const html = render({
      receipt: {
        ...baseReceipt,
        confirmed: false,
        authority: "sandbox",
        document_id: "artifact_sav_aaaaaaaa",
      },
    });
    expect(html).toContain("Тестовая QA-копия, сдача здесь не считается");
    expect(html).toContain('data-authority="sandbox"');
    expect(html).toContain('data-testid="submission-receipt-sandbox"');
    // Ссылка на документ у QA-копии не рисуется: report роли в основном
    // сервере, не в песочнице — чтобы владелец не кликнул в чужой документ.
    expect(html).not.toContain("/notes/artifact_sav_aaaaaaaa");
  });

  it("primary + confirmed=false показывает «не подтверждена», без ссылки", () => {
    const html = render({
      receipt: { ...baseReceipt, confirmed: false },
    });
    expect(html).toContain("Сдача основным сервером не подтверждена");
    expect(html).toContain('data-testid="submission-receipt-unconfirmed"');
    expect(html).toContain('data-authority="primary"');
    expect(html).toContain('data-confirmed="false"');
    // В этом сценарии document_id есть (отчёт роли записан), но ссылка на
    // отчёт не рисуем: подтверждения нет — открывать чужой документ нельзя.
    expect(html).not.toContain("/notes/artifact_sav_aaaaaaaa");
  });

  it("подтверждённая квитанция без document_id всё равно рисует бейдж и время", () => {
    const html = render({
      receipt: {
        ...baseReceipt,
        document_id: null,
        artifact_id: null,
      },
    });
    expect(html).toContain("Сдача подтверждена сервером");
    expect(html).toContain("09.10.26 12:34 UTC");
    // Нет ни ссылки, ни ID артефакта — но бейдж и время есть.
    expect(html).not.toContain("/notes/");
    expect(html).not.toContain("артефакт ");
  });

  it("ошибка сети показывает предупреждение вместо ложного успеха", () => {
    const html = render({ receipt: null, error: new Error("network") });
    expect(html).toContain('data-testid="submission-receipt-error"');
    expect(html).toContain("Не удалось прочитать квитанцию сдачи");
    expect(html).not.toContain("Сдача подтверждена сервером");
  });

  it("loading=true и пустая квитанция показывает нейтральную подсказку", () => {
    const html = render({ receipt: null, loading: true });
    expect(html).toContain('data-testid="submission-receipt-loading"');
    expect(html).toContain("Проверяю подтверждение сдачи");
  });

  it("не ISO-время не падает, форматирует как есть", () => {
    const html = render({
      receipt: {
        ...baseReceipt,
        confirmed_at: "2026-10-09 12:34:56",
      },
    });
    expect(html).toContain("09.10.26 12:34 UTC");
  });
});