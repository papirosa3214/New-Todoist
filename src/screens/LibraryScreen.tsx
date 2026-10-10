// ═══════════ TaskFlow Library ═══════════
//
// 08.10.2026. Корневая папка библиотеки знаний TaskFlow с четырьмя
// подпапками (Roles, Workflows, Norms, Knowledge Base). Это общий дом
// знаний для ролей: они читают отсюда через taskflow_kb_search в первую
// очередь и сами пополняют через taskflow_doc_write.
//
// По решению владельца UI сделан скромно: список 4 подпапок со счётчиком
// заметок и ссылкой на существующий NotesScreen с фильтром по folder_id.
// Никаких вкладок, отдельных редакторов или заметных акцентов —
// содержимое правится теми же инструментами, что и остальные заметки.
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ScreenHeader, Icon, Loading, ErrorBanner, EmptyState } from "../components/UI";

interface LibraryResponse {
  root: { id: number; name: string };
  subfolders: Array<{ id: number; name: string; position: number; notes_count: number }>;
}

const SUBFOLDER_DESCRIPTIONS: Record<string, string> = {
  Roles: "Метаинформация о ролях: кто что умеет, знает, делает.",
  Workflows: "Регламенты и шпаргалки по работе.",
  Norms: "Внутренние нормативные документы TaskFlow.",
  "Knowledge Base": "Накопленные знания о TaskFlow и смежных системах.",
  Projects: "Документация по конкретным проектам: что за проект, контекст, договорённости.",
};

export function LibraryScreen() {
  const navigate = useNavigate();
  const [data, setData] = useState<LibraryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/library", { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body.error || body.detail || `HTTP ${r.status}`);
        }
        return r.json();
      })
      .then((d: LibraryResponse) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message || String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="min-h-[100dvh] flex flex-col bg-bg">
        <ScreenHeader title="Библиотека" back />
        <div className="px-4 pt-4">
          <ErrorBanner error={error} />
          {error.includes("не инициализирована") && (
            <p className="tf-row text-sub mt-3">
              Инициализируется одной командой на сервере:{" "}
              <code className="px-1 py-0.5 bg-card rounded text-text">
                npx tsx scripts/bootstrap-taskflow-library.ts
              </code>
            </p>
          )}
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="min-h-[100dvh] flex flex-col bg-bg">
        <ScreenHeader title="Библиотека" back />
        <Loading />
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] flex flex-col bg-bg">
      <ScreenHeader title={data.root.name} back />
      <div className="px-4 pt-2 pb-6 flex-1">
        <p className="tf-row text-sub mb-4 leading-relaxed">
          Корневая папка знаний TaskFlow: роли используют её как один из источников
          контекста и пополняют сами. Содержимое правится обычными инструментами
          заметок — эта страница только обзор структуры.
        </p>
        {data.subfolders.length === 0 ? (
          <EmptyState icon="folder" title="Подпапок пока нет">
            Запустите bootstrap, чтобы создать Roles, Workflows, Norms и Knowledge Base.
          </EmptyState>
        ) : (
          <ul className="flex flex-col gap-2">
            {data.subfolders.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => navigate(`/notes?folder=${s.id}`)}
                  className="w-full text-left rounded-2xl bg-card px-4 py-3 active:opacity-70"
                >
                  <div className="flex items-center gap-3">
                    <Icon name="folder" size={22} className="text-accent" />
                    <div className="flex-1 min-w-0">
                      <div className="tf-body text-text font-medium">{s.name}</div>
                      <div className="tf-row text-sub truncate">
                        {SUBFOLDER_DESCRIPTIONS[s.name] || "Раздел библиотеки."}
                      </div>
                    </div>
                    <span className="tf-row text-sub tabular-nums">{s.notes_count}</span>
                    <Icon name="chevron-right" size={18} className="text-dim" />
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}