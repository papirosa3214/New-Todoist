// ═══════════ Редактор заметки ═══════════
//
// 26.08.2026. Экран /notes/:id — сама заметка: название сверху, текст под
// ним. Открывается тапом из списка (/notes, /notes/folder/:id) или сразу
// после «Создать заметку».
//
// Каркас списан с редактора Дневника по дням (JournalScreen) — та
// сущность удалена 26.08.2026 вместе с экраном: заметки стали
// самостоятельными и Дневник дублировал их, оставшись без входа.
//
// Сохранение: debounce 800мс, и ОБЯЗАТЕЛЬНО досрочный сброс при уходе с
// экрана — иначе последние нажатия клавиш теряются. Шлём PATCH только с
// изменёнными полями (в Дневнике PUT с обязательным content однажды чуть
// не стёр запись при смене папки).
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Highlight from "@tiptap/extension-highlight";
import Placeholder from "@tiptap/extension-placeholder";
import Link from "@tiptap/extension-link";
import { TableKit } from "@tiptap/extension-table";
import { Icon, ScreenHeader, ErrorBanner, Loading } from "../components/UI";
import { useDialog } from "../components/Dialog";
import { ActionsMenu, type ActionsMenuItem } from "../components/ActionsMenu";
import { TasksFromTextSheet } from "../components/TasksFromTextSheet";
import { AiBusyPill } from "../components/AiBusyPill";
import { MicKeyboardBar } from "../components/MicKeyboardBar";
import { MicOverlay } from "../components/MicOverlay";
import { useMicRecorder } from "../lib/useMicRecorder";
import { useTranscribeAudio } from "../api/audio";
import {
  useJournalAssist,
  useExtractTasksFromText,
  type JournalAssistAction,
  type ExtractedTask,
} from "../api/ai";
import { useNote, useUpdateNote, useDeleteNote } from "../api/notes";
import { api } from "../api/client";
import { useJournalFolders } from "../api/journal";
import { tiptapToMarkdown, safeFileName } from "../lib/tiptapToMarkdown";

type SaveState = "idle" | "saving" | "saved" | "error";
const SAVE_DEBOUNCE_MS = 800;

/** Ответ AI — plain text; строки «- пункт» собираем в список. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function resultToHtml(text: string): string {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return "";
  if (lines.every((l) => l.startsWith("- "))) {
    return `<ul>${lines.map((l) => `<li>${escapeHtml(l.slice(2))}</li>`).join("")}</ul>`;
  }
  return lines.map((l) => `<p>${escapeHtml(l)}</p>`).join("");
}

/** Название заметки = первая непустая строка текста.
 *
 *  Отдельного поля названия нет, поэтому в списке заметку надо чем-то
 *  подписывать. Берём первый блок с текстом — H1, H2 или обычный абзац.
 *  Обрезаем до 200 символов: столько же принимает сервер. */
function deriveTitle(editor: Editor): string {
  let found = "";
  editor.state.doc.descendants((node) => {
    if (found) return false;
    if (node.isTextblock) {
      const text = node.textContent.trim();
      if (text) {
        found = text.slice(0, 200);
        return false;
      }
    }
    return true;
  });
  return found;
}

function ToolbarButton({
  active,
  disabled,
  onClick,
  label,
  icon,
}: {
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  label: string;
  icon: string;
}) {
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()} // не отбирать фокус у редактора
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={!!active}
      className={`tap-scale shrink-0 w-9 h-9 flex items-center justify-center rounded-lg disabled:opacity-30 ${
        active ? "bg-red/15 text-red" : "text-sub"
      }`}
    >
      <Icon name={icon} size={17} />
    </button>
  );
}

function Toolbar({ editor, disabled }: { editor: Editor; disabled: boolean }) {
  // Кнопка «ссылка» требует URL — отдельный обработчик вместо прямого
  // toggleMark. Снимаем ссылку, если курсор уже внутри неё; иначе
  // расширяем выделение по link-марке и спрашиваем URL. window.prompt —
  // минимум зависимостей; полноценный inline-инпут в поповере можно
  // добавить позже, если понадобится (29.08.2026, задача 9b4c4984).
  const handleLinkClick = () => {
    if (disabled) return;
    const previous = (editor.getAttributes("link").href as string | undefined) ?? "";
    if (editor.isActive("link")) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    const url = window.prompt("Адрес ссылки", previous || "https://");
    if (url === null) return; // отмена
    const trimmed = url.trim();
    if (!trimmed) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    editor
      .chain()
      .focus()
      .extendMarkRange("link")
      .setLink({ href: trimmed })
      .run();
  };

  return (
    <div
      // Тулбар прокручивается вбок — свайп «назад» не должен его перехватывать.
      // Приклеен к верху под шапкой (--screen-header-h публикует
      // usePublishHeaderHeight в UI.tsx) — иначе при наборе текста
      // курсор уезжает вверх, редактор прокручивается, и тулбар
      // исчезает за верхней кромкой. На десктопе шапка той же высоты,
      // top=var(--screen-header-h, 0px) сажает тулбар сразу под неё.
      // z-10, чтобы уходить под саму шапку (у неё z-20), но идти над
      // содержимым редактора. Фон bg-bg обязателен: иначе под тулбаром
      // будет виднеться текст, на который он наезжает.
      data-hswipe
      style={{ top: "var(--screen-header-h, 0px)" }}
      className="sticky z-10 flex items-center gap-0.5 overflow-x-auto py-1.5 border-b border-stroke mb-2 -mx-4 px-4 bg-bg"
    >
      <ToolbarButton
        label="Жирный"
        icon="bold"
        disabled={disabled}
        active={editor.isActive("bold")}
        onClick={() => editor.chain().focus().toggleBold().run()}
      />
      <ToolbarButton
        label="Курсив"
        icon="italic"
        disabled={disabled}
        active={editor.isActive("italic")}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      />
      <ToolbarButton
        label="Подчёркнутый"
        icon="underline"
        disabled={disabled}
        active={editor.isActive("underline")}
        onClick={() => editor.chain().focus().toggleUnderline().run()}
      />
      <ToolbarButton
        label="Зачёркнутый"
        icon="strike"
        disabled={disabled}
        active={editor.isActive("strike")}
        onClick={() => editor.chain().focus().toggleStrike().run()}
      />
      <ToolbarButton
        label="Выделить маркером"
        icon="highlighter"
        disabled={disabled}
        active={editor.isActive("highlight")}
        onClick={() => editor.chain().focus().toggleHighlight().run()}
      />
      <ToolbarButton
        label="Строчный код"
        icon="inlineCode"
        disabled={disabled}
        active={editor.isActive("code")}
        onClick={() => editor.chain().focus().toggleCode().run()}
      />
      <ToolbarButton
        label="Ссылка"
        icon="link"
        disabled={disabled}
        active={editor.isActive("link")}
        onClick={handleLinkClick}
      />
      <div className="w-px h-5 bg-stroke mx-1 shrink-0" />
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        disabled={disabled}
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
        aria-pressed={editor.isActive("heading", { level: 1 })}
        className={`tap-scale shrink-0 h-9 px-2 rounded-lg text-[13px] font-bold disabled:opacity-30 ${
          editor.isActive("heading", { level: 1 })
            ? "bg-red/15 text-red"
            : "text-sub"
        }`}
      >
        H1
      </button>
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        disabled={disabled}
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        aria-pressed={editor.isActive("heading", { level: 2 })}
        className={`tap-scale shrink-0 h-9 px-2 rounded-lg text-[13px] font-bold disabled:opacity-30 ${
          editor.isActive("heading", { level: 2 })
            ? "bg-red/15 text-red"
            : "text-sub"
        }`}
      >
        H2
      </button>
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        disabled={disabled}
        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
        aria-pressed={editor.isActive("heading", { level: 3 })}
        className={`tap-scale shrink-0 h-9 px-2 rounded-lg text-[13px] font-bold disabled:opacity-30 ${
          editor.isActive("heading", { level: 3 })
            ? "bg-red/15 text-red"
            : "text-sub"
        }`}
      >
        H3
      </button>
      <div className="w-px h-5 bg-stroke mx-1 shrink-0" />
      <ToolbarButton
        label="Маркированный список"
        icon="listBullet"
        disabled={disabled}
        active={editor.isActive("bulletList")}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
      />
      <ToolbarButton
        label="Нумерованный список"
        icon="listOrdered"
        disabled={disabled}
        active={editor.isActive("orderedList")}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
      />
      <ToolbarButton
        label="Чек-бокс"
        icon="listChecks"
        disabled={disabled}
        active={editor.isActive("taskList")}
        onClick={() => editor.chain().focus().toggleTaskList().run()}
      />
      <div className="w-px h-5 bg-stroke mx-1 shrink-0" />
      <ToolbarButton
        label="Цитата"
        icon="quote"
        disabled={disabled}
        active={editor.isActive("blockquote")}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
      />
      <ToolbarButton
        label="Блок кода"
        icon="codeBlock"
        disabled={disabled}
        active={editor.isActive("codeBlock")}
        onClick={() => editor.chain().focus().toggleCodeBlock().run()}
      />
      <ToolbarButton
        label="Разделитель"
        icon="hr"
        disabled={disabled}
        onClick={() => editor.chain().focus().setHorizontalRule().run()}
      />
      <div className="w-px h-5 bg-stroke mx-1 shrink-0" />
      <ToolbarButton
        label="Таблица"
        icon="table"
        disabled={disabled}
        active={editor.isActive("table")}
        onClick={() =>
          editor
            .chain()
            .focus()
            .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
            .run()
        }
      />
      {/* Управление строками и столбцами показывается, только когда
          курсор внутри таблицы: в обычном тексте эти кнопки всё равно
          неактивны и лишь удлиняют и без того прокручиваемый тулбар. */}
      {editor.isActive("table") && (
        <>
          <ToolbarButton
            label="Строка ниже"
            icon="tableRow"
            disabled={disabled}
            onClick={() => editor.chain().focus().addRowAfter().run()}
          />
          <ToolbarButton
            label="Столбец справа"
            icon="tableColumn"
            disabled={disabled}
            onClick={() => editor.chain().focus().addColumnAfter().run()}
          />
          <ToolbarButton
            label="Удалить таблицу"
            icon="trash"
            disabled={disabled}
            onClick={() => editor.chain().focus().deleteTable().run()}
          />
        </>
      )}
    </div>
  );
}

/**
 * Похож ли текст из буфера на markdown, который стоит разобрать.
 *
 * Проверка намеренно строгая: обычный текст со случайным дефисом в начале
 * строки трогать нельзя, иначе вставка простого абзаца начнёт молча менять
 * форматирование. Срабатываем на том, что человек и правда копирует из
 * markdown: строка-разделитель таблицы, заголовок решёткой, забор кода или
 * несколько пунктов списка подряд.
 */
function looksLikeMarkdown(text: string): boolean {
  const lines = text.split(/\r?\n/);
  const hasTableDivider = lines.some((l) =>
    /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(l),
  );
  const hasHeading = lines.some((l) => /^#{1,6}\s+\S/.test(l));
  const hasFence = lines.some((l) => /^```/.test(l));
  const bulletCount = lines.filter((l) => /^\s*[-*+]\s+\S/.test(l)).length;
  return hasTableDivider || hasHeading || hasFence || bulletCount >= 2;
}

export function NoteEditorScreen() {
  const navigate = useNavigate();
  const params = useParams();
  const noteId = params.id ?? "";
  const { confirm, dialog } = useDialog();

  const { data: note, isLoading, error } = useNote(noteId);
  const updateNote = useUpdateNote(noteId);
  const deleteNote = useDeleteNote();
  const { data: foldersData } = useJournalFolders();
  const folders = foldersData?.folders ?? [];

  const journalAssist = useJournalAssist();
  const extractTasks = useExtractTasksFromText();

  // Название НЕ отдельное поле (26.08.2026, Максим: «убрать это название,
  // зачем мы его внедрили, и оставить заголовки — я сам выбираю»). Было
  // два способа задать одно и то же: поле сверху и H1 в тулбаре. Осталось
  // одно — заголовок прямо в тексте; в списке заметка подписывается его
  // первой значимой строкой. Состояние нужно только для показа в диалоге
  // удаления и в имени файла при экспорте.
  const [title, setTitle] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [aiBusy, setAiBusy] = useState(false);
  // Что показывать в плашке под островком. Общее «ИИ думает…» не врёт, но
  // и не сообщает ничего: человек только что выбрал действие в меню и
  // ждёт именно его.
  const [aiLabel, setAiLabel] = useState("ИИ думает…");
  const [aiError, setAiError] = useState<Error | null>(null);
  const [extractedTasks, setExtractedTasks] = useState<ExtractedTask[]>([]);
  const [tasksSheetOpen, setTasksSheetOpen] = useState(false);
  const [editorFocused, setEditorFocused] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const menuAnchorRef = useRef<HTMLButtonElement | null>(null);
  const aiAnchorRef = useRef<HTMLButtonElement | null>(null);
  const [aiMenuOpen, setAiMenuOpen] = useState(false);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<{ title?: string; content?: string }>({});
  const loadedRef = useRef(false);
  const editorRef = useRef<Editor | null>(null);

  const transcribeAudio = useTranscribeAudio();
  const mic = useMicRecorder(async (blob) => {
    try {
      const { text } = await transcribeAudio.mutateAsync(blob);
      const ed = editorRef.current;
      if (ed && text.trim()) {
        ed.chain().focus().insertContent(`<p>${text.trim()}</p>`).run();
      }
    } catch {
      // Причина уже в transcribeAudio.error — покажет ErrorBanner ниже.
    } finally {
      mic.finish();
    }
  });
  const micElapsedLabel = (() => {
    const total = Math.floor(mic.elapsedMs / 1000);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
  })();

  /** Планирует сохранение: копит изменения и шлёт их одним PATCH. */
  const scheduleSave = (patch: { title?: string; content?: string }) => {
    setSaveState("saving");
    pendingRef.current = { ...pendingRef.current, ...patch };
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      const body = pendingRef.current;
      pendingRef.current = {};
      if (Object.keys(body).length === 0) return;
      updateNote.mutate(body, {
        onSuccess: () => setSaveState("saved"),
        onError: () => setSaveState("error"),
      });
    }, SAVE_DEBOUNCE_MS);
  };

  const editor = useEditor({
    extensions: [
      StarterKit,
      TaskList,
      TaskItem.configure({ nested: true }),
      Highlight,
      Placeholder.configure({ placeholder: "Пишите здесь что угодно…" }),
      // Ссылка — отдельным расширением; StarterKit её не включает.
      // openOnClick:false оставляет ссылку некликабельной прямо в
      // редакторе — иначе тап по ней сразу открывал бы браузер, что
      // мешает выделению и редактированию.
      Link.configure({ openOnClick: false, autolink: true }),
      // Таблицы (08.09.2026). До этого расширения не было вовсе: markdown
      // с таблицей приходил от агентов строками «| a | b |», и каждая
      // строка ложилась отдельным абзацем — в заметке были палки вместо
      // сетки. resizable даёт тянуть колонки мышью.
      TableKit.configure({ table: { resizable: true } }),
    ],
    content: "",
    editable: false,
    editorProps: {
      // Вставка markdown из буфера. Без этого TipTap принимает текст как
      // простой: строки таблицы склеиваются в ОДИН абзац через hardBreak,
      // палки остаются символами, а строки с дефисом уезжают в буллеты.
      // Так были испорчены 9 заметок проекта (найдено 22.09.2026).
      // Разбирает тот же серверный markdownToTiptap, что и путь отчётов —
      // второй парсер в бандле означал бы две разные правды.
      handlePaste: (view, event) => {
        const text = event.clipboardData?.getData("text/plain");
        // HTML в буфере TipTap разбирает сам и делает это хорошо —
        // перехватываем только чистый текст.
        const html = event.clipboardData?.getData("text/html");
        if (!text || html) return false;
        if (!looksLikeMarkdown(text)) return false;

        event.preventDefault();
        // Запрос асинхронный, а handlePaste синхронный: отменяем вставку
        // здесь и досылаем разобранный документ, когда ответ придёт.
        void api
          .post<{ doc: unknown }>("/api/notes/markdown-to-doc", {
            markdown: text,
          })
          .then((res) => {
            const doc = res?.doc as { content?: unknown[] } | undefined;
            if (doc?.content?.length) {
              view.dispatch(view.state.tr.scrollIntoView());
              editorRef.current?.commands.insertContent(doc.content as never);
            }
          })
          .catch(() => {
            // Сервер не ответил — вставляем как было, лишь бы не потерять
            // содержимое буфера.
            editorRef.current?.commands.insertContent(text);
          });
        return true;
      },
    },
    onFocus: () => setEditorFocused(true),
    onBlur: () => setEditorFocused(false),
    onUpdate: ({ editor }) => {
      // Заголовок заметки — её первая значимая строка (обычно H1, но
      // сойдёт и обычный абзац, если человек просто начал писать).
      // Сохраняется вместе с содержимым, чтобы список не парсил TipTap
      // на каждую строку.
      const derived = deriveTitle(editor);
      setTitle(derived);
      scheduleSave({
        content: JSON.stringify(editor.getJSON()),
        title: derived,
      });
    },
  });

  useEffect(() => {
    if (!editor || !note || loadedRef.current) return;
    loadedRef.current = true;
    editorRef.current = editor;
    setTitle(note.title);
    if (note.content) {
      try {
        editor.commands.setContent(JSON.parse(note.content));
      } catch {
        // битый/чужой формат — открываем пустую страницу, не рушим экран
      }
    }
    editor.setEditable(true);
  }, [editor, note]);

  // Досрочно СОХРАНЯЕМ (не отменяем) незавершённый debounce при уходе —
  // иначе последние нажатия клавиш пропадают. Зависимость — именно
  // updateNote.mutate: сам объект мутации пересоздаётся каждый рендер.
  useEffect(
    () => () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      const body = pendingRef.current;
      pendingRef.current = {};
      if (Object.keys(body).length > 0) updateNote.mutate(body);
    },
    [updateNote.mutate],
  );

  useEffect(() => () => editor?.destroy(), [editor]);

  const statusLabel =
    saveState === "saving"
      ? "Сохранение…"
      : saveState === "saved"
        ? "Сохранено"
        : saveState === "error"
          ? "Не удалось сохранить"
          : "";

  function selectedOrWholeText(): { text: string; from: number; to: number } {
    if (!editor) return { text: "", from: 0, to: 0 };
    const { from, to } = editor.state.selection;
    if (from !== to) {
      return { text: editor.state.doc.textBetween(from, to, "\n"), from, to };
    }
    return { text: editor.getText(), from, to };
  }

  async function runAssist(action: JournalAssistAction) {
    if (!editor) return;
    const { text, from, to } = selectedOrWholeText();
    if (!text.trim()) return;
    const hasSelection = from !== to;
    setAiError(null);
    setAiLabel(
      action === "continue"
        ? "Продолжаю мысль…"
        : action === "shorten"
          ? "Сокращаю текст…"
          : "Развиваю в шаги…",
    );
    setAiBusy(true);
    editor.setEditable(false);
    try {
      const res = await journalAssist.mutateAsync({ text, action });
      const html = resultToHtml(res.result);
      if (!html) return;
      const range = hasSelection
        ? { from, to }
        : action === "continue"
          ? {
              from: editor.state.doc.content.size,
              to: editor.state.doc.content.size,
            }
          : { from: 0, to: editor.state.doc.content.size };
      editor.chain().focus().insertContentAt(range, html).run();
    } catch (err) {
      setAiError(
        err instanceof Error ? err : new Error("Не удалось получить ответ AI"),
      );
    } finally {
      setAiBusy(false);
      editor.setEditable(true);
    }
  }

  async function runExtractTasks() {
    if (!editor) return;
    const { text } = selectedOrWholeText();
    if (!text.trim()) return;
    setAiError(null);
    setAiLabel("Собираю задачи…");
    setAiBusy(true);
    try {
      const res = await extractTasks.mutateAsync(text);
      // На странный ответ сервера (200 + пустое тело, не-JSON, { tasks: null })
      // клиентский api.post вернёт null/undefined. Без этой проверки
      // `res.tasks` падает с TypeError прямо в render-phase, и пользователь
      // видит белый экран (карточка 70697681). Теперь — понятный баннер.
      const extracted = Array.isArray(res?.tasks) ? res.tasks : [];
      setExtractedTasks(extracted);
      if (extracted.length === 0) {
        setAiError(new Error("AI не нашёл в тексте конкретных задач"));
        return;
      }
      setTasksSheetOpen(true);
    } catch (err) {
      setAiError(
        err instanceof Error ? err : new Error("Не удалось извлечь задачи"),
      );
    } finally {
      setAiBusy(false);
    }
  }

  /** Выгрузить заметку файлом .md.
   *
   * Заметки хранятся деревом TipTap — внутренним форматом редактора;
   * наружу отдаём markdown, который открывается в Obsidian и где угодно
   * (26.08.2026, Максим: «JSON для работы, markdown на экспорт»).
   *
   * Ссылка со `download`, а не window.open: у blob-ссылки нет имени
   * файла, и заметка уехала бы в загрузки под случайным набором
   * символов. Тот же приём, что в AttachmentView.tsx — там это уже
   * ловили на вложениях.
   */
  const handleExport = () => {
    const md = tiptapToMarkdown(
      editorRef.current ? JSON.stringify(editorRef.current.getJSON()) : null,
    );
    // Заголовок НЕ дописываем: он уже внутри текста (отдельного поля
    // названия больше нет, H1 ставится в самом документе). Дописав его,
    // получили бы дубль первой строки.
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = safeFileName(title);
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Освобождаем не сразу: браузер ещё читает ссылку в момент сохранения.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  const handleDelete = async () => {
    const ok = await confirm({
      title: `Удалить заметку${title ? ` «${title}»` : ""}?`,
      description: "Действие нельзя отменить.",
      confirmLabel: "Удалить",
      danger: true,
    });
    if (!ok) return;
    await deleteNote.mutateAsync(noteId);
    navigate(-1);
  };

  const aiItems: ActionsMenuItem[] = [
    {
      icon: "penLine",
      label: "Продолжить мысль",
      onClick: () => void runAssist("continue"),
    },
    {
      icon: "scissors",
      label: "Сократить текст",
      onClick: () => void runAssist("shorten"),
    },
    {
      icon: "listTree",
      label: "Развить в шаги",
      onClick: () => void runAssist("expand"),
    },
    {
      icon: "listChecks",
      label: "Собрать задачи из текста",
      onClick: () => void runExtractTasks(),
    },
  ];

  const menuItems: ActionsMenuItem[] = [
    {
      icon: "folder",
      label: "Переместить в папку",
      onClick: () => setMoveOpen(true),
    },
    {
      icon: "share",
      label: "Выгрузить в Markdown",
      onClick: handleExport,
    },
    {
      icon: "trash",
      label: "Удалить заметку",
      destructive: true,
      onClick: () => void handleDelete(),
    },
  ];

  // Список папок для перемещения — плоский, с отступами по вложенности.
  const moveItems: ActionsMenuItem[] = [
    {
      icon: "fileText",
      label: "Вне папок",
      onClick: () => {
        updateNote.mutate({ folder_id: null });
        setMoveOpen(false);
      },
    },
    ...folders.map((f) => ({
      icon: "folder",
      label: f.name,
      onClick: () => {
        updateNote.mutate({ folder_id: f.id });
        setMoveOpen(false);
      },
    })),
  ];

  return (
    <div className="px-4 pb-4 flex flex-col flex-1">
      {dialog}
      {/* Статус ИИ — плашкой вверху экрана, под вырезом, а не строкой в
          теле: работа занимает секунды, и её должно быть видно, куда бы
          человек ни смотрел. */}
      <AiBusyPill visible={aiBusy} label={aiLabel} />
      <ScreenHeader
        variant="compact"
        title=""
        actions={
          <>
            <button
              ref={aiAnchorRef}
              type="button"
              onClick={() => setAiMenuOpen((v) => !v)}
              aria-label="AI-действия"
              aria-expanded={aiMenuOpen}
              disabled={aiBusy}
              className={`tap-scale w-[44px] h-[44px] flex items-center justify-center rounded-lg disabled:opacity-30 ${
                aiMenuOpen ? "bg-red/15 text-red" : "text-text"
              }`}
            >
              <Icon name="sparkles" size={18} />
            </button>
            <button
              ref={menuAnchorRef}
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              aria-label="Ещё"
              aria-expanded={menuOpen}
              className="tap-scale w-[44px] h-[44px] flex items-center justify-center rounded-lg text-text"
            >
              <Icon name="dots" size={18} />
            </button>
          </>
        }
      />

      {isLoading && <Loading />}
      <ErrorBanner
        error={error}
        fallback="Не удалось загрузить заметку"
        className="mt-2"
      />

      {editor && (
        <>
          <Toolbar editor={editor} disabled={aiBusy} />
          <ErrorBanner
            error={aiError}
            fallback="Не удалось выполнить действие AI"
            className="mb-2"
          />

          <div className="tiptap-content flex-1">
            <EditorContent editor={editor} />
          </div>

          <div className="text-[12px] text-dim px-1 pt-2 h-4">
            {statusLabel}
          </div>
        </>
      )}

      <ErrorBanner
        error={transcribeAudio.error}
        fallback="Не удалось распознать запись"
        className="mt-2"
      />

      {/* Микрофон — только когда открыта клавиатура (правило всех экранов). */}
      {editor && editorFocused && !aiBusy && mic.state === "idle" && (
        <MicKeyboardBar onStart={mic.start} ariaLabel="Надиктовать заметку" />
      )}
      {(mic.state === "recording" || mic.state === "processing") && (
        <MicOverlay
          state={mic.state}
          elapsedLabel={micElapsedLabel}
          getTimeDomainData={mic.getTimeDomainData}
          onStop={mic.stop}
        />
      )}

      <ActionsMenu
        open={aiMenuOpen}
        onClose={() => setAiMenuOpen(false)}
        anchorRef={aiAnchorRef}
        items={aiItems}
      />
      <ActionsMenu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        anchorRef={menuAnchorRef}
        items={menuItems}
      />
      <ActionsMenu
        open={moveOpen}
        onClose={() => setMoveOpen(false)}
        anchorRef={menuAnchorRef}
        items={moveItems}
      />

      <TasksFromTextSheet
        open={tasksSheetOpen}
        onClose={() => setTasksSheetOpen(false)}
        tasks={extractedTasks}
      />
    </div>
  );
}
