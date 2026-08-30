// ═══════════ Дневник: дерево папок и заметок ═══════════
//
// 26.08.2026. Раздел веера «Дневник» (/notes). Внутри — файловое дерево,
// как левая панель Obsidian: одна плоская лента строк с отступом по
// уровню вложенности. Тап по папке раскрывает её ПРЯМО ЗДЕСЬ, под ней
// появляется содержимое, внутри — снова папки, и так вглубь.
//
// История двух отвергнутых заходов (чтобы не вернуться к ним снова):
//   1. Аккордеон карточками — каждая папка была карточкой, вложенная
//      папка становилась карточкой внутри карточки. Матрёшка, вложенность
//      не читалась.
//   2. Отдельный экран на папку (/notes/folder/:id) — Максим: «я думал,
//      будет как у всех древовидное, как в Obsidian: нажимаешь, под ней
//      открывается содержимое, и я мог бы это содержимое перетаскивать».
// Отсюда третий, нынешний: строки + отступы + раскрытие на месте.
//
// Раскрытые папки помнятся в состоянии экрана (не на сервере): это вид,
// а не данные — на другом устройстве своё дерево может быть раскрыто
// иначе, и синхронизировать тут нечего.
//
// Правила Максима (skill taskflow-development):
// - одна функция — один вход;
// - красный только для активного/тревоги;
// - тащат всю строку, без грип-ручек; тап открывает, удержание тащит.
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { ScreenHeader, Icon, Loading, ErrorBanner } from "../components/UI";
import { useDialog } from "../components/Dialog";
import { ActionsMenu } from "../components/ActionsMenu";
import {
  useJournalFolders,
  useCreateJournalFolder,
  useUpdateJournalFolder,
  useDeleteJournalFolder,
  useMoveJournalFolder,
  type ApiJournalFolder,
} from "../api/journal";
import {
  useNotes,
  useCreateNote,
  useMoveNote,
  useDeleteNote,
  type ApiNoteSummary,
} from "../api/notes";
import { hapticGrab, hapticDrop } from "../lib/haptics";
import { useTapGuard } from "../lib/useTapGuard";
import { tiptapToMarkdown, safeFileName } from "../lib/tiptapToMarkdown";
import { api } from "../api/client";

/** Отступ на уровень вложенности. 18px — та же ступень, что у списков
 *  подзадач: меньше не читается как вложенность, больше съедает ширину
 *  на четвёртом уровне. */
const INDENT = 18;

const folderDragId = (id: number) => `folder:${id}`;
const noteDragId = (id: string) => `note:${id}`;
const dropId = (folderId: number | null) =>
  folderId == null ? "drop:root" : `drop:${folderId}`;

type DragPayload =
  | { kind: "note"; note: ApiNoteSummary }
  | { kind: "folder"; folder: ApiJournalFolder };

/** Все id поддерева включая корень — папку нельзя бросить в себя/потомка. */
function collectSubtree(
  folders: ApiJournalFolder[],
  rootId: number,
): Set<number> {
  const byParent = new Map<number | null, ApiJournalFolder[]>();
  for (const f of folders) {
    const arr = byParent.get(f.parent_id) ?? [];
    arr.push(f);
    byParent.set(f.parent_id, arr);
  }
  const out = new Set<number>([rootId]);
  const walk = (id: number) => {
    for (const child of byParent.get(id) ?? []) {
      out.add(child.id);
      walk(child.id);
    }
  };
  walk(rootId);
  return out;
}

/**
 * Выгружает папку со всем содержимым в .md-файлы.
 *
 * Без ZIP намеренно: тянуть архиватор в бандл ради экспорта — дорого, а
 * Capacitor/WKWebView всё равно сохраняет файлы по одному. Структура
 * папок передаётся в ИМЕНИ файла («Работа — Спринт — заметка.md»), так
 * она читается и после выгрузки в плоскую папку загрузок.
 *
 * Контент тянется по одной заметке: список приходит без него (там только
 * превью), иначе экран вёз бы весь TipTap-JSON каждой записи.
 */
async function exportSubtree(
  rootId: number | null,
  folders: ApiJournalFolder[],
  notes: ApiNoteSummary[],
): Promise<number> {
  const byParent = new Map<number | null, ApiJournalFolder[]>();
  for (const f of folders) {
    const arr = byParent.get(f.parent_id) ?? [];
    arr.push(f);
    byParent.set(f.parent_id, arr);
  }

  const targets: { note: ApiNoteSummary; path: string[] }[] = [];
  const walk = (folderId: number | null, path: string[]) => {
    for (const n of notes.filter((x) => x.folder_id === folderId)) {
      targets.push({ note: n, path });
    }
    for (const child of byParent.get(folderId) ?? []) {
      walk(child.id, [...path, child.name]);
    }
  };
  const rootName =
    rootId == null ? [] : [folders.find((f) => f.id === rootId)?.name ?? ""];
  walk(rootId, rootName.filter(Boolean));

  for (const { note, path } of targets) {
    const full = await api.get<{ title: string; content: string }>(
      `/api/notes/${note.id}`,
    );
    const prefix = path.length > 0 ? `${path.join(" — ")} — ` : "";
    await saveNoteFile(full.title, full.content, prefix);
  }
  return targets.length;
}

/**
 * Выгружает конкретные заметки (отмеченные в режиме выбора).
 *
 * Отдельно от exportSubtree: тот обходит дерево от папки, а здесь список
 * уже готов и обходить нечего. Общая часть — сохранение одного файла —
 * вынесена в saveNoteFile.
 */
async function exportNotes(list: ApiNoteSummary[]): Promise<number> {
  for (const n of list) {
    const full = await api.get<{ title: string; content: string }>(
      `/api/notes/${n.id}`,
    );
    await saveNoteFile(full.title, full.content, "");
  }
  return list.length;
}

/** Сохраняет одну заметку .md-файлом. prefix несёт путь папок в имени. */
async function saveNoteFile(title: string, content: string, prefix: string) {
  // Заголовок уже внутри текста — отдельного поля названия нет,
  // дописывать «# …» значило бы дублировать первую строку.
  const body = tiptapToMarkdown(content);
  const blob = new Blob([body], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = safeFileName(prefix + (title || "Заметка"));
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  // Пауза между файлами: браузер режет пачку одновременных загрузок.
  await new Promise((r) => setTimeout(r, 150));
}

/** Строка дерева: либо папка, либо заметка, со своим уровнем вложенности. */
/** Для каждого уровня-предка: продолжается ли его вертикаль ниже этой
 *  строки. Без этого у последней ветки тянулись бы «висячие» линии от
 *  давно закончившихся уровней. */
type Ancestors = boolean[];

type Row =
  | {
      kind: "folder";
      folder: ApiJournalFolder;
      depth: number;
      childCount: number;
      /** Последняя строка среди соседей — направляющая обрывается на ней. */
      last: boolean;
      ancestors: Ancestors;
    }
  | {
      kind: "note";
      note: ApiNoteSummary;
      depth: number;
      last: boolean;
      ancestors: Ancestors;
    };

/** Разворачивает дерево в плоский список видимых строк — рекурсия здесь,
 *  а не в компоненте: так рендер остаётся простым списком, а раскрытие
 *  сводится к пересчёту одного массива. */
function flattenTree(
  folders: ApiJournalFolder[],
  notes: ApiNoteSummary[],
  expanded: Set<number>,
): Row[] {
  const byParent = new Map<number | null, ApiJournalFolder[]>();
  for (const f of folders) {
    const arr = byParent.get(f.parent_id) ?? [];
    arr.push(f);
    byParent.set(f.parent_id, arr);
  }
  for (const arr of byParent.values()) {
    arr.sort((a, b) => a.position - b.position || a.id - b.id);
  }
  const notesByFolder = new Map<number | null, ApiNoteSummary[]>();
  for (const n of notes) {
    const arr = notesByFolder.get(n.folder_id) ?? [];
    arr.push(n);
    notesByFolder.set(n.folder_id, arr);
  }

  const rows: Row[] = [];
  const walk = (
    parentId: number | null,
    depth: number,
    ancestors: Ancestors,
  ) => {
    const siblingFolders = byParent.get(parentId) ?? [];
    const siblingNotes = notesByFolder.get(parentId) ?? [];
    siblingFolders.forEach((folder, i) => {
      const childFolders = byParent.get(folder.id) ?? [];
      const childNotes = notesByFolder.get(folder.id) ?? [];
      // Папка замыкает уровень, только если после неё нет ни других папок,
      // ни заметок этого же уровня.
      const last = i === siblingFolders.length - 1 && siblingNotes.length === 0;
      rows.push({
        kind: "folder",
        folder,
        depth,
        childCount: childFolders.length + childNotes.length,
        last,
        ancestors,
      });
      // Вниз по дереву: этот уровень продолжается для потомков, только
      // если после папки ещё есть соседи.
      if (expanded.has(folder.id)) {
        walk(folder.id, depth + 1, [...ancestors, !last]);
      }
    });
    // Заметки идут ПОСЛЕ папок того же уровня — как в файловых
    // менеджерах: сначала каталоги, потом файлы.
    siblingNotes.forEach((note, i) => {
      rows.push({
        kind: "note",
        note,
        depth,
        last: i === siblingNotes.length - 1,
        ancestors,
      });
    });
  };
  walk(null, 0, []);
  return rows;
}

export function NotesScreen() {
  const navigate = useNavigate();
  const { confirm, alert, dialog } = useDialog();

  const { data: foldersData, error: foldersError } = useJournalFolders();
  const {
    data: notesData,
    isLoading: notesLoading,
    error: notesError,
  } = useNotes();

  const folders = useMemo(() => foldersData?.folders ?? [], [foldersData]);
  const notes = useMemo(() => notesData?.notes ?? [], [notesData]);

  // Какие папки раскрыты. Вид, а не данные — на сервер не ходит.
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const toggle = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const rows = useMemo(
    () => flattenTree(folders, notes, expanded),
    [folders, notes, expanded],
  );

  const createFolder = useCreateJournalFolder();
  const createNote = useCreateNote();
  const moveNote = useMoveNote();
  const moveFolder = useMoveJournalFolder();
  const deleteNote = useDeleteNote();
  const deleteFolder = useDeleteJournalFolder();
  const [moveOpen, setMoveOpen] = useState(false);
  const [rowMenuOpen, setRowMenuOpen] = useState(false);
  // Переименование живёт в режиме выбора: три точки у каждой строки убраны
  // (26.08.2026), а действие это про ОДНУ папку, не про набор — поэтому
  // пункт появляется, только когда отмечена ровно одна папка.
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const rowMenuAnchorRef = useRef<HTMLButtonElement | null>(null);

  const [exporting, setExporting] = useState(false);
  // ═══ Режим выбора ═══
  //
  // 26.08.2026, Максим: «в шапке три точки, там „выбрать элемент“, я
  // отмечаю чекбоксами что надо и, например, выгружаю в Markdown, или то
  // же удаление, перемещение».
  //
  // Свайпы строк рассматривали и отвергли: жест уже занят перетаскиванием,
  // а вторая механика поверх — «всем свайпы опять же вот эти какие-то».
  // Один вход для групповых действий вместо двух разных механик.
  //
  // Ключи — те же строковые id, что у drag: "folder:1", "note:uuid".
  // Так один Set хранит и папки, и заметки без разбора типов.
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const createAnchorRef = useRef<HTMLButtonElement | null>(null);
  const [showCreateFolder, setShowCreateFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");

  // ═══ Drag ═══
  const dragRef = useRef<DragPayload | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const forbiddenRef = useRef<Set<number>>(new Set());

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 200, tolerance: 8 },
    }),
  );

  function handleDragStart(e: DragStartEvent) {
    const id = String(e.active.id);
    if (id.startsWith("note:")) {
      const note = notes.find((n) => n.id === id.slice(5));
      if (!note) return;
      dragRef.current = { kind: "note", note };
      forbiddenRef.current = new Set();
    } else if (id.startsWith("folder:")) {
      const folderId = Number(id.slice(7));
      const folder = folders.find((f) => f.id === folderId);
      if (!folder) return;
      dragRef.current = { kind: "folder", folder };
      forbiddenRef.current = collectSubtree(folders, folderId);
    }
    setDragging(id);
    hapticGrab();
  }

  function handleDragEnd(e: DragEndEvent) {
    const payload = dragRef.current;
    dragRef.current = null;
    setDragging(null);
    forbiddenRef.current = new Set();
    if (!payload || !e.over) return;

    const overId = String(e.over.id);
    if (!overId.startsWith("drop:")) return;
    const raw = overId.slice(5);
    const targetId = raw === "root" ? null : Number(raw);

    if (payload.kind === "note") {
      if (payload.note.folder_id === targetId) return;
      hapticDrop();
      moveNote.mutate({ id: payload.note.id, folder_id: targetId });
      // Бросили в папку — раскрываем её, иначе заметка «исчезает».
      if (targetId !== null) setExpanded((p) => new Set(p).add(targetId));
      return;
    }
    if (
      targetId !== null &&
      collectSubtree(folders, payload.folder.id).has(targetId)
    ) {
      return;
    }
    if (payload.folder.parent_id === targetId) return;
    hapticDrop();
    moveFolder.mutate({ id: payload.folder.id, parent_id: targetId });
    if (targetId !== null) setExpanded((p) => new Set(p).add(targetId));
  }

  const toggleSelected = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const exitSelecting = () => {
    setSelecting(false);
    setSelected(new Set());
  };

  const handleCreateFolder = async (e: FormEvent) => {
    e.preventDefault();
    const name = newFolderName.trim();
    if (!name) return;
    await createFolder.mutateAsync({ name, parent_id: null });
    setNewFolderName("");
    setShowCreateFolder(false);
  };

  /** Разбирает отметки на папки и заметки — id несут тип префиксом. */
  const splitSelection = () => {
    const folderIds: number[] = [];
    const noteIds: string[] = [];
    for (const key of selected) {
      if (key.startsWith("folder:")) folderIds.push(Number(key.slice(7)));
      else if (key.startsWith("note:")) noteIds.push(key.slice(5));
    }
    return { folderIds, noteIds };
  };

  /** Выгрузить отмеченное. Папка выгружается со всем содержимым. */
  const exportSelected = async () => {
    const { folderIds, noteIds } = splitSelection();
    setExporting(true);
    try {
      let count = 0;
      for (const id of folderIds) {
        count += await exportSubtree(id, folders, notes);
      }
      // Заметки, отмеченные поштучно. Те, что уже уехали в составе
      // выбранной папки, второй раз не выгружаем.
      const covered = new Set<string>();
      for (const id of folderIds) {
        for (const nid of collectSubtree(folders, id)) {
          notes
            .filter((n) => n.folder_id === nid)
            .forEach((n) => covered.add(n.id));
        }
      }
      const standalone = notes.filter(
        (n) => noteIds.includes(n.id) && !covered.has(n.id),
      );
      if (standalone.length > 0) {
        count += await exportNotes(standalone);
      }
      exitSelecting();
      if (count === 0) {
        await alert({
          title: "Выгружать нечего",
          description: "В отмеченном нет заметок.",
        });
      }
    } catch {
      await alert({
        title: "Не удалось выгрузить",
        description: "Часть заметок могла не сохраниться. Попробуйте ещё раз.",
      });
    } finally {
      setExporting(false);
    }
  };

  /** Удалить отмеченное. Папка удаляется вместе с вложенными папками,
   *  заметки внутри остаются — просто выпадают в корень. */
  const deleteSelected = async () => {
    const { folderIds, noteIds } = splitSelection();
    const parts: string[] = [];
    if (folderIds.length) parts.push(`папок: ${folderIds.length}`);
    if (noteIds.length) parts.push(`заметок: ${noteIds.length}`);
    const ok = await confirm({
      title: "Удалить отмеченное?",
      description:
        `Будет удалено — ${parts.join(", ")}. ` +
        "Заметки внутри удалённых папок не пропадут: они останутся вне папок. " +
        "Действие нельзя отменить.",
      confirmLabel: "Удалить",
      danger: true,
    });
    if (!ok) return;
    for (const id of noteIds) await deleteNote.mutateAsync(id);
    for (const id of folderIds) await deleteFolder.mutateAsync(id);
    exitSelecting();
  };

  /** Переместить отмеченное в выбранную папку (или в корень). */
  const moveSelectedTo = async (target: number | null) => {
    const { folderIds, noteIds } = splitSelection();
    for (const id of noteIds) {
      await moveNote.mutateAsync({ id, folder_id: target });
    }
    for (const id of folderIds) {
      // Папку нельзя положить внутрь себя или своего потомка — сервер это
      // отбивает, но и запрос слать незачем.
      if (target !== null && collectSubtree(folders, id).has(target)) continue;
      await moveFolder.mutateAsync({ id, parent_id: target });
    }
    if (target !== null) setExpanded((p) => new Set(p).add(target));
    setMoveOpen(false);
    exitSelecting();
  };

  /** Выгрузка папки (или всего Дневника при null) в .md-файлы. */
  const handleExport = async (folderId: number | null) => {
    setExporting(true);
    try {
      const count = await exportSubtree(folderId, folders, notes);
      if (count === 0) {
        await alert({
          title: "Выгружать нечего",
          description: "В этой папке нет заметок.",
        });
      }
    } catch {
      await alert({
        title: "Не удалось выгрузить",
        description: "Часть заметок могла не сохраниться. Попробуйте ещё раз.",
      });
    } finally {
      setExporting(false);
    }
  };

  const handleCreateNote = async (folderId: number | null) => {
    const note = await createNote.mutateAsync({
      title: "",
      content: "",
      folder_id: folderId,
    });
    navigate(`/notes/${note.id}`);
  };

  // Удержание главной кнопки на «Дневнике» (27.08.2026, владелец) заводит
  // заметку — тем же приёмом ?create=1, что и «Проекты» (ProjectsScreen).
  // Параметр сразу чистится из адресной строки (не только ref-guard):
  // навигация уводит на /notes/:id, но возврат «Назад» ремонтирует этот
  // экран заново — свежий createHandledRef без чистки параметра завёл бы
  // ЕЩЁ одну пустую заметку.
  const [searchParams, setSearchParams] = useSearchParams();
  const createHandledRef = useRef(false);
  useEffect(() => {
    if (searchParams.get("create") !== "1" || createHandledRef.current) return;
    createHandledRef.current = true;
    setSearchParams(
      (prev) => {
        prev.delete("create");
        return prev;
      },
      { replace: true },
    );
    void handleCreateNote(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- один раз на маунт по флагу в URL, не на каждый рендер handleCreateNote/setSearchParams
  }, [searchParams]);

  const isEmpty = !notesLoading && rows.length === 0;

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => {
        dragRef.current = null;
        setDragging(null);
        forbiddenRef.current = new Set();
      }}
    >
      <div className="px-4 pb-4 flex flex-col flex-1">
        {dialog}
        {/* В режиме выбора шапка другая: слева «Отмена», по центру счётчик
            вместо названия. Так видно, что приложение в особом состоянии, и
            из него есть очевидный выход. */}
        <ScreenHeader
          title={
            selecting
              ? selected.size > 0
                ? `Выбрано: ${selected.size}`
                : "Выберите элементы"
              : "Дневник"
          }
          leading={
            selecting ? (
              <button
                onClick={exitSelecting}
                className="h-[44px] px-2 flex items-center text-[15px] text-text tap-row"
              >
                Отмена
              </button>
            ) : undefined
          }
          actions={
            selecting ? (
              <button
                ref={rowMenuAnchorRef}
                onClick={() => setRowMenuOpen((v) => !v)}
                disabled={selected.size === 0}
                aria-label="Действия с выбранным"
                className="w-[44px] h-[44px] flex items-center justify-center tap-row disabled:opacity-30"
              >
                <Icon name="dots" size={18} />
              </button>
            ) : (
              <button
                ref={createAnchorRef}
                onClick={() => {
                  if (showCreateFolder) setShowCreateFolder(false);
                  else setCreateMenuOpen((v) => !v);
                }}
                aria-label={showCreateFolder ? "Отменить" : "Меню"}
                aria-expanded={createMenuOpen}
                className="w-[44px] h-[44px] flex items-center justify-center tap-row"
              >
                {/* Три точки, как во всём приложении (26.08.2026, Максим:
                    «наверху вместо плюсика сделаем три точки, как и везде»).
                    Создание переехало внутрь этого меню. */}
                <Icon name={showCreateFolder ? "x" : "dots"} size={18} />
              </button>
            )
          }
        />

        <ActionsMenu
          open={createMenuOpen}
          onClose={() => setCreateMenuOpen(false)}
          anchorRef={createAnchorRef}
          items={[
            {
              icon: "fileText",
              label: "Создать заметку",
              onClick: () => void handleCreateNote(null),
            },
            {
              icon: "folder",
              label: "Создать папку",
              onClick: () => setShowCreateFolder(true),
            },
            {
              icon: "listChecks",
              label: "Выбрать элементы",
              onClick: () => setSelecting(true),
            },
            {
              icon: "share",
              label: "Выгрузить всё в Markdown",
              onClick: () => void handleExport(null),
            },
          ]}
        />

        {/* Действия над отмеченным. Открывается тремя точками в режиме
            выбора; пункты работают со всем набором сразу. */}
        <ActionsMenu
          open={rowMenuOpen}
          onClose={() => setRowMenuOpen(false)}
          anchorRef={rowMenuAnchorRef}
          items={[
            // Переименование — только для одной отмеченной папки: у набора
            // общего имени нет.
            ...(selected.size === 1 && [...selected][0].startsWith("folder:")
              ? [
                  {
                    icon: "penLine",
                    label: "Переименовать",
                    onClick: () => {
                      setRenamingId(Number([...selected][0].slice(7)));
                      setSelecting(false);
                      setSelected(new Set());
                    },
                  },
                ]
              : []),
            {
              icon: "folder",
              label: "Переместить в папку",
              onClick: () => setMoveOpen(true),
            },
            {
              icon: "share",
              label: "Выгрузить в Markdown",
              onClick: () => void exportSelected(),
            },
            {
              icon: "trash",
              label: "Удалить",
              destructive: true,
              onClick: () => void deleteSelected(),
            },
          ]}
        />

        {/* Куда переместить. Папки плоским списком — в дерево тут не
            уйти, а имён обычно хватает, чтобы узнать нужную. */}
        <ActionsMenu
          open={moveOpen}
          onClose={() => setMoveOpen(false)}
          anchorRef={rowMenuAnchorRef}
          items={[
            {
              icon: "fileText",
              label: "Вне папок",
              onClick: () => void moveSelectedTo(null),
            },
            ...folders.map((f) => ({
              icon: "folder",
              label: f.name,
              onClick: () => void moveSelectedTo(f.id),
            })),
          ]}
        />

        {showCreateFolder && (
          <form
            onSubmit={handleCreateFolder}
            className="bg-card rounded-2xl p-4 mb-3"
          >
            <input
              autoFocus
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              placeholder="Название папки"
              maxLength={80}
              className="w-full bg-card2 rounded-xl px-3 py-2.5 text-[16px] text-text placeholder:text-dim outline-none mb-3"
            />
            <ErrorBanner
              error={createFolder.error}
              fallback="Не удалось создать папку"
              variant="block"
              className="mb-3"
            />
            <button
              type="submit"
              disabled={!newFolderName.trim() || createFolder.isPending}
              className="w-full h-12 bg-red rounded-xl text-[14px] font-semibold text-white disabled:opacity-50 tap-fade"
            >
              {createFolder.isPending ? "Создаём…" : "Создать"}
            </button>
          </form>
        )}

        {notesLoading && notes.length === 0 && <Loading />}
        <ErrorBanner
          error={notesError}
          fallback="Не удалось загрузить заметки"
          variant="inline"
          className="mb-2"
        />
        <ErrorBanner
          error={foldersError}
          fallback="Не удалось загрузить папки"
          variant="inline"
          className="mb-2"
        />
        <ErrorBanner
          error={moveNote.error ?? moveFolder.error ?? createNote.error}
          fallback="Не удалось выполнить действие"
          variant="inline"
          className="mb-2"
        />

        {exporting && (
          <p className="text-[13px] text-dim px-1 pb-2">Выгружаем заметки…</p>
        )}

        {isEmpty && !showCreateFolder ? (
          <EmptyState onCreateNote={() => void handleCreateNote(null)} />
        ) : (
          <>
            {/* Корень — тоже цель: сюда вытаскивают из папок наружу.
                Сама лента и есть эта зона, отдельной полоски не нужно. */}
            <RootDropZone active={dragging !== null}>
              <div className="flex flex-col">
                {rows.map((row) =>
                  row.kind === "folder" ? (
                    <FolderRow
                      key={`f${row.folder.id}`}
                      folder={row.folder}
                      depth={row.depth}
                      childCount={row.childCount}
                      expanded={expanded.has(row.folder.id)}
                      onToggle={() => toggle(row.folder.id)}
                      dragging={dragging}
                      forbidden={forbiddenRef.current}
                      selecting={selecting}
                      checked={selected.has(folderDragId(row.folder.id))}
                      onToggleChecked={() =>
                        toggleSelected(folderDragId(row.folder.id))
                      }
                      last={row.last}
                      ancestors={row.ancestors}
                      renaming={renamingId === row.folder.id}
                      onRenamed={() => setRenamingId(null)}
                    />
                  ) : (
                    <NoteRow
                      key={`n${row.note.id}`}
                      note={row.note}
                      dragging={dragging}
                      onOpen={() => navigate(`/notes/${row.note.id}`)}
                      selecting={selecting}
                      checked={selected.has(noteDragId(row.note.id))}
                      onToggleChecked={() =>
                        toggleSelected(noteDragId(row.note.id))
                      }
                      last={row.last}
                      ancestors={row.ancestors}
                    />
                  ),
                )}
              </div>
            </RootDropZone>
          </>
        )}
      </div>

      <DragOverlay dropAnimation={null}>
        {dragging && dragRef.current ? (
          <div className="drag-lift bg-card2 border border-stroke rounded-xl px-3 py-2 flex items-center gap-2 shadow-dropdown">
            <Icon
              name={dragRef.current.kind === "folder" ? "folder" : "fileText"}
              size={16}
              className="text-sub shrink-0"
            />
            <span className="text-[14px] font-semibold text-text truncate max-w-[220px]">
              {dragRef.current.kind === "folder"
                ? dragRef.current.folder.name
                : dragRef.current.note.title || "Без названия"}
            </span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

/** Вся лента — цель «в корень». Подсвечивается только во время
 *  перетаскивания и только по краю, чтобы не спорить со строками. */
function RootDropZone({
  active,
  children,
}: {
  active: boolean;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: dropId(null) });
  return (
    <div
      ref={setNodeRef}
      className="rounded-xl"
      style={{
        outline: active && isOver ? "1px dashed var(--color-red)" : "none",
        outlineOffset: 4,
      }}
    >
      {children}
    </div>
  );
}

/** Квадратик отметки в режиме выбора. Один на папки и заметки — рисовать
 *  два одинаковых незачем. */
function SelectBox({ checked }: { checked: boolean }) {
  return (
    <span
      className="shrink-0 w-[18px] h-[18px] rounded-[5px] border flex items-center justify-center"
      style={{
        borderColor: checked ? "var(--color-red)" : "var(--color-stroke)",
        backgroundColor: checked ? "var(--color-red)" : "transparent",
        transition: "background-color 120ms ease, border-color 120ms ease",
      }}
    >
      {checked && <Icon name="check" size={12} className="text-white" />}
    </span>
  );
}

/** Направляющие вложенности — вертикальные линии слева от строки.
 *
 * 26.08.2026, Максим: «можно подзапутаться, находится ли оно в папке или
 * нет — чтобы отображались веточки графические, так было бы гораздо
 * понятнее». До этого вложенность несли только отступы: на втором-третьем
 * уровне глаз уже не считает, чей это отступ.
 *
 * Рисуем ровно depth столбиков ширины INDENT, в каждом — линия по центру.
 * Линия проходит всю высоту строки: соседние строки стыкуются встык и
 * образуют непрерывную вертикаль вдоль всей папки, как в файловых
 * менеджерах.
 *
 * У последнего уровня линия обрывается на середине и уходит вправо
 * «уголком» — это и есть та веточка, что связывает строку с родителем.
 */
function TreeGuides({
  ancestors,
  last,
}: {
  /** По одному признаку на уровень-предок: тянуть ли его вертикаль. */
  ancestors: boolean[];
  /** Эта строка замыкает свою группу — её вертикаль обрывается уголком. */
  last: boolean;
}) {
  const depth = ancestors.length;
  if (depth === 0) return null;
  return (
    <>
      {ancestors.map((continues, i) => {
        const isOwn = i === depth - 1;
        // Столбик предка рисуется, только если тот уровень ещё
        // продолжается ниже. Иначе линия «висела» бы от давно
        // закончившейся ветки — типичная ошибка отрисовки деревьев.
        const showLine = isOwn || continues;
        return (
          <span
            key={i}
            aria-hidden
            className="relative shrink-0 self-stretch"
            style={{ width: INDENT }}
          >
            {showLine && (
              <span
                className="absolute top-0 w-px bg-stroke"
                style={{
                  left: "50%",
                  // Своя вертикаль обрывается на середине, если строка
                  // последняя: дальше линии идти некуда.
                  bottom: isOwn && last ? "50%" : 0,
                }}
              />
            )}
            {/* Уголок к самой строке — только у своего уровня. */}
            {isOwn && (
              <span
                className="absolute h-px bg-stroke"
                style={{ left: "50%", right: 0, top: "50%" }}
              />
            )}
          </span>
        );
      })}
    </>
  );
}

// ────────── Строка папки ──────────

function FolderRow({
  folder,
  depth,
  childCount,
  expanded,
  onToggle,
  dragging,
  forbidden,
  selecting,
  checked,
  onToggleChecked,
  last,
  ancestors,
  renaming,
  onRenamed,
}: {
  folder: ApiJournalFolder;
  depth: number;
  childCount: number;
  expanded: boolean;
  onToggle: () => void;
  dragging: string | null;
  forbidden: Set<number>;
  /** Экран в режиме выбора — строка показывает чекбокс. */
  selecting: boolean;
  checked: boolean;
  onToggleChecked: () => void;
  /** Последняя строка в своей группе — направляющая обрывается. */
  last: boolean;
  /** Признаки продолжения для каждого уровня-предка. */
  ancestors: boolean[];
  /** Эту папку переименовывают — строка превращается в поле ввода. */
  renaming: boolean;
  onRenamed: () => void;
}) {
  const [renameValue, setRenameValue] = useState(folder.name);

  const updateFolder = useUpdateJournalFolder();

  const isBeingDragged = dragging === folderDragId(folder.id);
  const isForbidden = forbidden.has(folder.id);

  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: dropId(folder.id),
    disabled: isForbidden,
  });
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
  } = useDraggable({
    id: folderDragId(folder.id),
    disabled: renaming || selecting,
  });
  // В режиме выбора тап отмечает строку, а не раскрывает её: иначе
  // пришлось бы целиться в маленький чекбокс.
  const tap = useTapGuard(() => (selecting ? onToggleChecked() : onToggle()));

  const submitRename = async (e: FormEvent) => {
    e.preventDefault();
    const name = renameValue.trim();
    if (!name || name === folder.name) {
      onRenamed();
      return;
    }
    await updateFolder.mutateAsync({ id: folder.id, name });
    onRenamed();
  };

  if (renaming) {
    return (
      <form
        onSubmit={submitRename}
        className="flex items-center gap-2 py-1"
        style={{ paddingLeft: depth * INDENT }}
      >
        <input
          autoFocus
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={onRenamed}
          maxLength={80}
          className="flex-1 bg-card2 rounded-lg px-3 py-2 text-[16px] text-text outline-none"
        />
        <button
          type="submit"
          onMouseDown={(e) => e.preventDefault()}
          className="h-9 px-3 rounded-lg bg-card2 text-[13px] text-text tap-row"
        >
          Готово
        </button>
      </form>
    );
  }

  return (
    <div
      ref={setDropRef}
      className="rounded-lg"
      style={{
        // Подсветка цели — заливкой: у строк нет рамок, обводка тут
        // выглядела бы чужеродно.
        backgroundColor: isOver ? "rgba(228,67,50,0.12)" : "transparent",
        transition: "background-color 120ms ease",
        visibility: isBeingDragged ? "hidden" : "visible",
      }}
    >
      <div
        ref={setDragRef}
        {...attributes}
        {...listeners}
        {...tap}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
        className="flex items-stretch gap-2 h-[42px] pr-1 select-none tap-row rounded-lg"
        style={{
          touchAction: "manipulation",
          WebkitTouchCallout: "none",
        }}
      >
        {/* Отступ теперь рисуют сами направляющие: столбик на уровень,
            с линией по центру. Раньше был просто paddingLeft. */}
        <TreeGuides ancestors={ancestors} last={last} />
        {selecting && (
          <span className="flex items-center">
            <SelectBox checked={checked} />
          </span>
        )}
        <span
          className="text-dim flex items-center shrink-0 w-4"
          style={{
            transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
            transition: "transform 120ms ease",
          }}
        >
          <Icon name="chevron" size={14} />
        </span>
        <span className="flex items-center shrink-0">
          <Icon name="folder" size={17} className="text-sub" />
        </span>
        <span className="flex items-center flex-1 min-w-0">
          <span className="text-[15px] text-text truncate">{folder.name}</span>
        </span>
        {childCount > 0 && (
          <span className="flex items-center text-[12px] text-dim tabular-nums">
            {childCount}
          </span>
        )}
      </div>
    </div>
  );
}

// ────────── Строка заметки ──────────

function NoteRow({
  note,
  dragging,
  onOpen,
  selecting,
  checked,
  onToggleChecked,
  last,
  ancestors,
}: {
  note: ApiNoteSummary;
  dragging: string | null;
  onOpen: () => void;
  /** Экран в режиме выбора — строка показывает чекбокс. */
  selecting: boolean;
  checked: boolean;
  onToggleChecked: () => void;
  /** Последняя строка в своей группе — направляющая обрывается. */
  last: boolean;
  /** Признаки продолжения для каждого уровня-предка. */
  ancestors: boolean[];
}) {
  const { attributes, listeners, setNodeRef } = useDraggable({
    id: noteDragId(note.id),
    // В режиме выбора перетаскивание выключено: удержание должно
    // оставаться отметкой, а не начинать перенос.
    disabled: selecting,
  });
  const isBeingDragged = dragging === noteDragId(note.id);
  // В режиме выбора тап отмечает строку, а не открывает её: иначе пришлось
  // бы целиться в маленький чекбокс.
  const tap = useTapGuard(() => (selecting ? onToggleChecked() : onOpen()));

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      {...tap}
      role="button"
      tabIndex={0}
      className="flex items-stretch gap-2 h-[42px] pr-2 select-none tap-row rounded-lg"
      style={{
        touchAction: "manipulation",
        WebkitTouchCallout: "none",
        visibility: isBeingDragged ? "hidden" : "visible",
      }}
    >
      {/* Направляющие ровно те же, что у соседних папок этого уровня —
          лишний уровень заметке НЕ добавляем. Заметка в корне не
          принадлежит ничему: ancestors пуст, TreeGuides вернёт null и
          строка встанет вровень с папками верхнего уровня (26.08.2026,
          Максим: «зачем, когда у меня есть папка и есть просто заметка, а
          это всё равно рисуется — они друг к другу не относятся»). */}
      <TreeGuides ancestors={ancestors} last={last} />
      {selecting && (
        <span className="flex items-center">
          <SelectBox checked={checked} />
        </span>
      )}
      <span className="flex items-center shrink-0">
        <Icon name="fileText" size={16} className="text-dim" />
      </span>
      <span className="flex items-center flex-1 min-w-0">
        <span className="text-[15px] text-text truncate">
          {note.title || "Без названия"}
        </span>
      </span>
    </div>
  );
}

// ────────── Пусто ──────────

function EmptyState({ onCreateNote }: { onCreateNote: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center text-center pt-16 gap-3">
      <Icon name="notebook" size={48} className="text-dim" />
      <p className="text-[16px] font-semibold text-text">Записей пока нет</p>
      <p className="text-[13px] text-sub max-w-[280px] leading-snug">
        Заметки складываются в папки — перетаскиванием или сразу при создании.
      </p>
      <button
        type="button"
        onClick={onCreateNote}
        className="tap-scale mt-3 h-11 px-5 rounded-xl bg-card2 text-[15px] font-semibold text-text flex items-center gap-2"
      >
        <Icon name="plus" size={18} />
        Создать заметку
      </button>
    </div>
  );
}
