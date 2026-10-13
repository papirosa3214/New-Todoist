"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Archive, ArchiveRestore, Plus } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { EmptyState } from "@/components/EmptyState";
import { ErrorBanner } from "@/components/ErrorBanner";
import { useSuccessToast } from "@/components/SuccessToast";

export type CategoryItem = {
  id: string;
  name: string;
  icon: string | null;
  archived: boolean;
  operationsCount?: number;
};

/** Раздел 7.6 — форма сверху, ниже сетка чипов вместо таблицы. */
export function CategoriesManager({ items }: { items: CategoryItem[] }) {
  const router = useRouter();
  const notify = useSuccessToast();
  const [name, setName] = React.useState("");
  const [icon, setIcon] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [archiveTarget, setArchiveTarget] = React.useState<CategoryItem | null>(null);

  const duplicate = React.useMemo(
    () => name.trim().length > 0 && items.some((c) => c.name.trim().toLowerCase() === name.trim().toLowerCase()),
    [name, items],
  );

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const res = await fetch("/api/categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), icon: icon.trim() || null }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body?.error?.message ?? "Не удалось создать категорию");
        return;
      }
      setName("");
      setIcon("");
      router.refresh();
      notify("Категория создана");
    } catch {
      setError("Нет связи с сервером. Проверьте подключение и повторите.");
    } finally {
      setPending(false);
    }
  }

  async function toggleArchive(item: CategoryItem) {
    setArchiveTarget(null);
    try {
      const res = await fetch(`/api/categories/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: !item.archived }),
      });
      if (!res.ok) throw new Error("bad status");
      router.refresh();
      notify(item.archived ? "Категория восстановлена" : "Категория в архиве");
    } catch {
      setError("Не удалось изменить категорию. Проверьте связь и повторите.");
    }
  }

  return (
    <div className="space-y-6">
      <form
        onSubmit={create}
        className="grid grid-cols-1 gap-3 rounded-xl border border-ink-200 bg-white p-4 md:grid-cols-3 md:p-5"
      >
        <div className="space-y-1 md:col-span-2">
          <Label htmlFor="cat-name">Название</Label>
          <Input
            id="cat-name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Продукты"
            aria-invalid={duplicate || undefined}
            aria-describedby={duplicate ? "cat-error" : undefined}
            className={duplicate ? "border-danger-500" : undefined}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="cat-icon">Иконка</Label>
          <Input
            id="cat-icon"
            value={icon}
            onChange={(e) => setIcon(e.target.value)}
            placeholder="одно-два символа"
            maxLength={4}
          />
        </div>
        <div className="md:col-span-3">
          <Button type="submit" disabled={pending || duplicate}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            {pending ? "Создаём…" : "Категория"}
          </Button>
          {duplicate ? (
            <p id="cat-error" className="mt-2 text-sm font-medium text-danger-600">
              Такая категория уже есть
            </p>
          ) : null}
        </div>
        {error ? <ErrorBanner message={error} className="md:col-span-3" /> : null}
      </form>

      {items.length === 0 ? (
        <div className="rounded-xl border border-ink-200 bg-white">
          <EmptyState
            title="Категорий пока нет"
            description="Категории группируют расходы в аналитике"
            action={
              <Button asChild>
                <a href="#cat-name">＋ Новая категория</a>
              </Button>
            }
          />
        </div>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
          {items.map((c) => (
            <li
              key={c.id}
              className={cn(
                "flex flex-col items-center gap-2 rounded-xl border border-ink-200 bg-white p-4 text-center",
                c.archived && "opacity-50",
              )}
            >
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-ink-100 text-base">
                {c.icon ?? (c.name?.[0] ?? "—")}
              </span>
              <span className="text-sm text-ink-900">{c.name}</span>
              <span className="text-xs text-ink-500">
                {c.archived
                  ? "В архиве"
                  : `${c.operationsCount ?? 0} в аналитике`}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setArchiveTarget(c)}
                aria-label={c.archived ? "Восстановить категорию" : "Архивировать категорию"}
              >
                {c.archived ? (
                  <>
                    <ArchiveRestore className="h-4 w-4" aria-hidden="true" />
                    Восстановить
                  </>
                ) : (
                  <>
                    <Archive className="h-4 w-4" aria-hidden="true" />
                    Архив
                  </>
                )}
              </Button>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={archiveTarget !== null}
        onOpenChange={(open) => !open && setArchiveTarget(null)}
        title={archiveTarget?.archived ? "Вернуть категорию из архива?" : "Архивировать категорию?"}
        description={
          archiveTarget?.archived
            ? "Категория снова будет доступна в форме операции."
            : "Категория уйдёт из списков выбора, но её операции останутся."
        }
        confirmLabel={archiveTarget?.archived ? "Восстановить" : "Архивировать"}
        onConfirm={() => archiveTarget && toggleArchive(archiveTarget)}
      />
    </div>
  );
}