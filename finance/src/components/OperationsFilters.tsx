"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Filter, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

export type OperationFilters = {
  account: string;
  category: string;
  from: string;
  to: string;
  q: string;
};

type Option = { id: string; name: string; icon?: string | null };

const EMPTY: OperationFilters = { account: "", category: "", from: "", to: "", q: "" };

function countActive(f: OperationFilters): number {
  return Object.values(f).filter((v) => v && v.length > 0).length;
}

/**
 * Раздел 7.3 — фильтры списка операций.
 * На телефоне свёрнуты в кнопку «Фильтры», применённые показаны чипами под заголовком.
 */
export function OperationsFilters({
  accounts,
  categories,
  value,
  page,
}: {
  accounts: Option[];
  categories: Option[];
  value: OperationFilters;
  page: number;
}) {
  const router = useRouter();
  const [filters, setFilters] = React.useState<OperationFilters>(value);
  const [open, setOpen] = React.useState(false);
  const active = countActive(value);

  function apply(next: OperationFilters) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(next)) {
      if (v) params.set(k, v);
    }
    if (params.toString()) params.set("page", String(page));
    const qs = params.toString();
    router.push(qs ? `/operations?${qs}` : "/operations");
    setOpen(false);
  }

  function clearOne(key: keyof OperationFilters) {
    apply({ ...value, [key]: "" });
  }

  const panel = (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-6">
      <div className="space-y-1">
        <Label htmlFor="f-account">Счёт</Label>
        <Select
          value={filters.account || "all"}
          onValueChange={(v) => setFilters((f) => ({ ...f, account: v === "all" ? "" : v }))}
        >
          <SelectTrigger id="f-account">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Все счета</SelectItem>
            {accounts.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="f-category">Категория</Label>
        <Select
          value={filters.category || "all"}
          onValueChange={(v) => setFilters((f) => ({ ...f, category: v === "all" ? "" : v }))}
        >
          <SelectTrigger id="f-category">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Все категории</SelectItem>
            {categories.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.icon ? `${c.icon} ${c.name}` : c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="f-from">С даты</Label>
        <Input
          id="f-from"
          type="date"
          value={filters.from}
          onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="f-to">По дату</Label>
        <Input
          id="f-to"
          type="date"
          value={filters.to}
          onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))}
        />
      </div>
      <div className="space-y-1 md:col-span-2">
        <Label htmlFor="f-q">Поиск по описанию</Label>
        <Input
          id="f-q"
          type="search"
          value={filters.q}
          onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))}
          placeholder="например, кофе"
        />
      </div>
      <div className="flex items-end gap-2 sm:col-span-2 md:col-span-6">
        <Button type="button" onClick={() => apply(filters)} className="flex-1 sm:flex-none">
          Применить
        </Button>
        <Button type="button" variant="secondary" onClick={() => { setFilters(EMPTY); apply(EMPTY); }}>
          Сбросить
        </Button>
      </div>
    </div>
  );

  return (
    <div className="space-y-3">
      <div className="hidden rounded-xl border border-ink-200 bg-white p-4 md:block">{panel}</div>

      <div className="md:hidden">
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild>
            <Button variant="outline" className="w-full" aria-label="Фильтры">
              <Filter className="h-4 w-4" aria-hidden="true" />
              Фильтры{active ? ` (${active})` : ""}
            </Button>
          </SheetTrigger>
          <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto pb-[max(1rem,env(safe-area-inset-bottom))]">
            <SheetHeader>
              <SheetTitle>Фильтры</SheetTitle>
            </SheetHeader>
            {panel}
          </SheetContent>
        </Sheet>
      </div>

      {active > 0 ? (
        <div className="flex flex-wrap gap-2">
          {value.account ? (
            <Chip label={accounts.find((a) => a.id === value.account)?.name ?? "Счёт"} onClear={() => clearOne("account")} />
          ) : null}
          {value.category ? (
            <Chip
              label={categories.find((c) => c.id === value.category)?.name ?? "Категория"}
              onClear={() => clearOne("category")}
            />
          ) : null}
          {value.from ? <Chip label={`с ${value.from}`} onClear={() => clearOne("from")} /> : null}
          {value.to ? <Chip label={`по ${value.to}`} onClear={() => clearOne("to")} /> : null}
          {value.q ? <Chip label={`«${value.q}»`} onClear={() => clearOne("q")} /> : null}
          <button
            type="button"
            onClick={() => apply(EMPTY)}
            className="text-sm text-accent-700 underline underline-offset-2"
          >
            Сбросить всё
          </button>
        </div>
      ) : null}
    </div>
  );
}

function Chip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full bg-accent-50 px-3 py-1 text-xs font-medium text-accent-700",
      )}
    >
      {label}
      <button type="button" onClick={onClear} aria-label={`Убрать фильтр ${label}`} className="p-1">
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </span>
  );
}