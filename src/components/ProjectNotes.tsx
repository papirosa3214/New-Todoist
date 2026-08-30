// ═══════════ Документация проекта ═══════════
//
// 26.08.2026, выбор Максима из четырёх вариантов связи заметок с задачами:
// «мне нравятся заметки у проекта — если есть какой-то проект, я бы мог
// прям прикрепить папку заметки и туда вот по этому проекту всё скидывать,
// вообще всю документацию».
//
// Привязка к заметке-к-задаче отвергнута им же: «в этом нет необходимости,
// потому что у ИИ в задаче есть своего рода заметки, описательная часть,
// там всё есть — задача и так уже полноценная».
//
// ═══ Устройство ═══
//
// Проект ССЫЛАЕТСЯ на существующую папку Дневника (projects.notes_folder_id
// → journal_folders.id), своей иерархии у него нет. Поэтому папка остаётся
// видна в общем дереве заметок, работает перетаскивание, ничего не
// дублируется. Отвязали проект — папка и заметки на месте.
//
// Показываем заметки самой папки И всех вложенных: документация обычно
// разложена по подпапкам, а на экране проекта нужен весь свод.
import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useNotes, useCreateNote } from "../api/notes";
import {
  useJournalFolders,
  useCreateJournalFolder,
  type ApiJournalFolder,
} from "../api/journal";
import { useUpdateProject } from "../api/projects";
import type { ApiProject } from "../api/types";
import { Icon } from "./UI";
import { ActionsMenu } from "./ActionsMenu";
import { useDialog } from "./Dialog";

/** Все id папки и её потомков — документация проекта живёт во всём поддереве. */
function collectSubtree(
  folders: ApiJournalFolder[],
  rootId: number,
): Set<number> {
  const out = new Set<number>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of folders) {
      if (f.parent_id !== null && out.has(f.parent_id) && !out.has(f.id)) {
        out.add(f.id);
        grew = true;
      }
    }
  }
  return out;
}

export function ProjectNotes({ project }: { project: ApiProject }) {
  const navigate = useNavigate();
  // Хуки отдают объекты-обёртки ({folders}/{notes}), не голые массивы.
  const { data: foldersData } = useJournalFolders();
  const { data: notesData } = useNotes();
  const folders = foldersData?.folders ?? [];
  const notes = notesData?.notes ?? [];
  const updateProject = useUpdateProject();
  const createFolder = useCreateJournalFolder();
  const createNote = useCreateNote();
  const { confirm, dialog } = useDialog();
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerAnchorRef = useRef<HTMLButtonElement | null>(null);
  const [busy, setBusy] = useState(false);

  const folderId = project.notes_folder_id ?? null;
  const folder = folders.find((f) => f.id === folderId) ?? null;

  const folderNotes = useMemo(() => {
    if (folderId === null) return [];
    const ids = collectSubtree(folders, folderId);
    return notes.filter((n) => n.folder_id !== null && ids.has(n.folder_id));
  }, [folderId, folders, notes]);

  /** Завести папку с именем проекта и сразу привязать её. */
  const createAndAttach = async () => {
    setBusy(true);
    try {
      const created = await createFolder.mutateAsync({
        name: project.name,
        parent_id: null,
      });
      await updateProject.mutateAsync({
        id: project.id,
        notes_folder_id: created.folder.id,
      });
    } finally {
      setBusy(false);
    }
  };

  const attach = async (id: number) => {
    setPickerOpen(false);
    await updateProject.mutateAsync({ id: project.id, notes_folder_id: id });
  };

  const detach = async () => {
    const ok = await confirm({
      title: "Открепить папку?",
      description:
        "Сама папка и заметки внутри останутся на месте — в Дневнике. " +
        "Здесь просто пропадёт эта секция.",
      confirmLabel: "Открепить",
    });
    if (!ok) return;
    await updateProject.mutateAsync({
      id: project.id,
      notes_folder_id: null,
    });
  };

  /** Новая заметка сразу внутри папки проекта. */
  const addNote = async () => {
    if (folderId === null) return;
    const created = await createNote.mutateAsync({ folder_id: folderId });
    navigate(`/notes/${created.id}`);
  };

  return (
    <div className="mt-6">
      {dialog}
      <div className="flex items-center justify-between mb-2">
        <div className="text-[17px] text-sub font-semibold">Документация</div>
        {folder ? (
          <button
            onClick={addNote}
            aria-label="Новая заметка"
            className="w-[44px] h-[44px] -mr-2.5 flex items-center justify-center tap-row"
          >
            <Icon name="plus" size={18} />
          </button>
        ) : null}
      </div>

      {!folder && (
        // Пусто — объясняем, что это даёт, и предлагаем оба пути: завести
        // новую папку под проект или привязать уже существующую.
        <div className="rounded-xl bg-card px-4 py-4">
          <p className="text-[13px] text-sub leading-snug mb-3">
            Прикрепите папку заметок — вся документация по проекту будет
            здесь же, рядом с задачами. Папка живёт в Дневнике, так что
            заметки можно перетаскивать и открывать оттуда.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => void createAndAttach()}
              disabled={busy}
              className="tap-scale h-10 px-4 rounded-xl bg-card2 text-[13px] font-semibold text-text flex items-center gap-2 disabled:opacity-50"
            >
              <Icon name="folderPlus" size={16} />
              {busy ? "Создаём…" : `Создать «${project.name}»`}
            </button>
            {folders.length > 0 && (
              <button
                ref={pickerAnchorRef}
                onClick={() => setPickerOpen(true)}
                className="tap-scale h-10 px-4 rounded-xl bg-card2 text-[13px] font-semibold text-text flex items-center gap-2"
              >
                <Icon name="folder" size={16} />
                Выбрать папку
              </button>
            )}
          </div>
        </div>
      )}

      {folder && (
        <>
          <button
            onClick={() => navigate("/notes")}
            className="w-full flex items-center gap-2 h-[42px] px-1 tap-row rounded-lg"
          >
            <Icon name="folder" size={17} className="text-sub shrink-0" />
            <span className="text-[15px] text-text flex-1 truncate text-left">
              {folder.name}
            </span>
            <span className="text-[12px] text-dim tabular-nums">
              {folderNotes.length}
            </span>
            <Icon name="chevron" size={14} className="text-dim shrink-0" />
          </button>

          {folderNotes.length === 0 ? (
            <p className="px-1 text-[13px] text-dim">
              В папке пока нет заметок
            </p>
          ) : (
            <div className="space-y-[2px]">
              {folderNotes.map((note) => (
                <button
                  key={note.id}
                  onClick={() => navigate(`/notes/${note.id}`)}
                  className="w-full flex items-center gap-2 h-[42px] pl-5 pr-2 tap-row rounded-lg"
                >
                  <Icon name="fileText" size={16} className="text-dim shrink-0" />
                  <span className="text-[15px] text-text flex-1 truncate text-left">
                    {note.title || "Без названия"}
                  </span>
                </button>
              ))}
            </div>
          )}

          <button
            onClick={() => void detach()}
            className="mt-2 px-1 h-9 text-[13px] text-dim tap-row"
          >
            Открепить папку
          </button>
        </>
      )}

      {/* Выбор существующей папки. Плоским списком: в дерево тут не уйти,
          а имён обычно хватает, чтобы узнать нужную. */}
      <ActionsMenu
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        anchorRef={pickerAnchorRef}
        items={folders.map((f) => ({
          icon: "folder",
          label: f.name,
          onClick: () => void attach(f.id),
        }))}
      />
    </div>
  );
}