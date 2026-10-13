"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export type CategoryItem = { id: string; name: string; icon: string | null; archived: boolean };

export function CategoriesManager({ items }: { items: CategoryItem[] }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        setError(body?.error?.message ?? "Не удалось");
        setPending(false);
        return;
      }
      setName("");
      setIcon("");
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  async function archive(id: string, archived: boolean) {
    await fetch(`/api/categories/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: !archived }),
    });
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <form
        onSubmit={create}
        className="bg-white border border-ink-200 rounded-xl p-4 grid grid-cols-1 md:grid-cols-3 gap-3"
      >
        <input
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Название"
          className="border border-ink-300 rounded-md px-3 py-2 text-sm"
        />
        <input
          value={icon}
          onChange={(e) => setIcon(e.target.value)}
          placeholder="Иконка (эмодзи)"
          maxLength={4}
          className="border border-ink-300 rounded-md px-3 py-2 text-sm"
        />
        <button
          type="submit"
          disabled={pending}
          className="bg-accent-600 text-white text-sm rounded-md px-3 py-2 hover:bg-accent-700 disabled:opacity-60"
        >
          {pending ? "Создаём…" : "+ Категория"}
        </button>
        {error ? <p className="text-sm text-danger-500 md:col-span-3">{error}</p> : null}
      </form>

      <div className="bg-white border border-ink-200 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-ink-100 text-ink-700">
            <tr>
              <th className="text-left px-3 py-2 font-medium">Иконка</th>
              <th className="text-left px-3 py-2 font-medium">Название</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-200">
            {items.length === 0 ? (
              <tr>
                <td colSpan={3} className="px-3 py-6 text-center text-ink-500">
                  Категорий пока нет
                </td>
              </tr>
            ) : (
              items.map((c) => (
                <tr key={c.id} className={c.archived ? "opacity-50" : ""}>
                  <td className="px-3 py-2 text-base">{c.icon ?? "—"}</td>
                  <td className="px-3 py-2">{c.name}</td>
                  <td className="px-3 py-2 text-right">
                    <button
                      onClick={() => archive(c.id, c.archived)}
                      className="text-ink-600 hover:text-ink-900 text-xs"
                    >
                      {c.archived ? "Восстановить" : "Архив"}
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}