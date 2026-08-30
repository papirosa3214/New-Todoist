// ═══════════ PROJECT LIST (Обзор → «Мои проекты») ═══════════
//
// Владелец 20.08.2026: «когда я вношу изменения, у меня появляется
// возможность менять их местами отображения... и закреплять какие-то,
// если они мне в большей степени интересны». Две независимые фичи на одном
// списке: ручной порядок (drag&drop) и закрепление наверх (pin).
//
// Технически — тот же паттерн, что TaskBoard.tsx уже использует для
// карточек задач (dnd-kit, drag ТОЛЬКО с выделенного grip-хэндла, а не со
// всей строки — иначе клик по проекту для перехода внутрь ломался бы), но
// сильно упрощённый: одна колонка вместо доски, без кросс-колоночного
// переноса.
//
// Закреплённые и обычные — ДВА независимых DndContext, не один общий.
// Причина: сервер всегда сортирует `pinned DESC, position ASC` (см.
// server/src/routes/projects.ts) — если бы drag разрешал перетащить
// обычный проект выше закреплённого, увиденный во время жеста порядок
// разошёлся бы с тем, что сохранится и вернётся после перезагрузки. Два
// контекста делают такое перемещение физически невозможным вместо того,
// чтобы полагаться на отдельную проверку в обработчике. Что показывать в
// какой группе, переключает только явный пункт меню «Закрепить», не drag.
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useQueryClient } from "@tanstack/react-query";
import { Icon } from "./UI";
import { ActionsMenu } from "./ActionsMenu";
import { useTapGuard } from "../lib/useTapGuard";
import { hapticGrab, hapticDrop } from "../lib/haptics";
import { api } from "../api/client";
import { useUpdateProject } from "../api/projects";
import type { ApiProject } from "../api/types";

function sortByPosition(list: ApiProject[]): ApiProject[] {
  return [...list].sort((a, b) => {
    const pa = a.position ?? Number.MAX_SAFE_INTEGER;
    const pb = b.position ?? Number.MAX_SAFE_INTEGER;
    return pa - pb;
  });
}

export function ProjectList({ projects }: { projects: ApiProject[] }) {
  const pinned = sortByPosition(projects.filter((p) => !!p.pinned));
  const rest = sortByPosition(projects.filter((p) => !p.pinned));

  return (
    <div className="space-y-[2px]">
      {pinned.length > 0 && <ProjectGroup projects={pinned} />}
      {rest.length > 0 && <ProjectGroup projects={rest} />}
    </div>
  );
}

// Одна группа — свой локальный порядок, синхронизированный с props тем же
// правилом, что colItems/persistingRef в TaskBoard.tsx: не перезаписывать
// локальное состояние, пока идёт сам жест или ещё летят PATCH по его
// итогам, иначе список визуально «отпрыгивает» на старое место на каждый
// чужой refetch/WS-инвалидацию, случившийся ровно в эту секунду.
function ProjectGroup({ projects }: { projects: ApiProject[] }) {
  const qc = useQueryClient();
  const byId = new Map(projects.map((p) => [p.id, p]));
  const [ids, setIds] = useState<string[]>(() => projects.map((p) => p.id));
  const [activeId, setActiveId] = useState<string | null>(null);
  const persistingRef = useRef(false);

  useEffect(() => {
    if (activeId !== null || persistingRef.current) return;
    setIds(projects.map((p) => p.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects]);

  // Тащат всю строку (грип-хендл убран, Максим 26.08.2026): мышь — от
  // 4px движения, палец — удержание 200мс (тап открывает проект, движение
  // сразу — скролл страницы). Та же пара сенсоров, что на доске и в
  // DayHours.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 200, tolerance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    setActiveId(null);
    if (!over || active.id === over.id) return;
    const oldIndex = ids.indexOf(String(active.id));
    const newIndex = ids.indexOf(String(over.id));
    if (oldIndex === -1 || newIndex === -1) return;

    const reordered = arrayMove(ids, oldIndex, newIndex);
    hapticDrop();
    setIds(reordered);
    persistingRef.current = true;
    try {
      const patches = reordered
        .map((id, index) => {
          const current = byId.get(id);
          return current && current.position !== index
            ? api.patch(`/api/projects/${id}`, { position: index })
            : null;
        })
        .filter((p): p is Promise<unknown> => p !== null);
      if (patches.length > 0) {
        await Promise.all(patches);
        await qc.invalidateQueries({ queryKey: ["projects"] });
      }
    } catch (err) {
      console.error("Не удалось сохранить порядок проектов", err);
      await qc.invalidateQueries({ queryKey: ["projects"] });
    } finally {
      persistingRef.current = false;
    }
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={(e) => {
        setActiveId(String(e.active.id));
        hapticGrab();
      }}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveId(null)}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        {ids.map((id) => {
          const p = byId.get(id);
          if (!p) return null;
          return (
            <ProjectRow key={id} project={p} isDragging={id === activeId} />
          );
        })}
      </SortableContext>
    </DndContext>
  );
}

function ProjectRow({
  project,
  isDragging,
}: {
  project: ApiProject;
  isDragging: boolean;
}) {
  const navigate = useNavigate();
  const updateProject = useUpdateProject();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuAnchorRef = useRef<HTMLButtonElement>(null);

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
  } = useSortable({ id: project.id });

  const tap = useTapGuard(() => navigate(`/projects/${project.id}`));

  return (
    <div
      ref={setNodeRef}
      // scale — в самом inline-transform: у sortable-строки transform уже
      // занят переносом (translate), класс с transform:scale был бы им
      // перебит. drag-lift здесь даёт только тень и пружину.
      style={{
        transform: isDragging
          ? `${CSS.Transform.toString(transform) ?? ""} scale(1.04)`
          : CSS.Transform.toString(transform),
        transition,
      }}
      // drag-lift при захвате — здесь нет DragOverlay (строка едет на
      // своём месте), поэтому подъём вешается прямо на неё.
      className={`flex items-stretch gap-0.5 bg-card rounded-xl ${isDragging ? "drag-lift relative z-10" : ""}`}
    >
      {/* Грип-хендл убран (Максим 26.08.2026) — drag начинается удержанием
          прямо на строке (TouchSensor delay 200мс / MouseSensor distance
          4px, см. sensors выше). Слушатели — на основной кнопке, НЕ на
          обёртке: удержание на кнопке «Ещё» должно открывать меню, а не
          таскать строку. Синтетический click после драга гасит useTapGuard.
          touchAction: manipulation — палец на строке всё ещё может начать
          прокрутку страницы. select-none/WebkitTouchCallout — чтобы
          удержание не выделяло текст и не поднимало системное меню. */}
      <button
        {...tap}
        {...attributes}
        {...listeners}
        style={{ touchAction: "manipulation", WebkitTouchCallout: "none" }}
        className="flex-1 min-w-0 flex items-center gap-3 py-2.5 pl-3 pr-1 text-left min-h-[44px] select-none"
      >
        <Icon name="hash" size={18} style={{ color: project.color }} />
        {!!project.pinned && (
          <Icon name="pin" size={12} className="text-dim shrink-0 -ml-1.5" />
        )}
        <span className="text-[14px] text-text flex-1 truncate">
          {project.name}
        </span>
        <span className="text-[13px] text-sub">{project.task_count}</span>
      </button>
      <button
        ref={menuAnchorRef}
        onClick={() => setMenuOpen((v) => !v)}
        aria-label="Ещё"
        className="shrink-0 w-[36px] flex items-center justify-center text-dim tap-row"
      >
        <Icon name="dots" size={16} />
      </button>
      <ActionsMenu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        anchorRef={menuAnchorRef}
        items={[
          {
            icon: "pin",
            label: project.pinned ? "Открепить" : "Закрепить",
            onClick: () =>
              updateProject.mutate({ id: project.id, pinned: !project.pinned }),
          },
        ]}
      />
    </div>
  );
}
