"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { UploadCloud } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/EmptyState";
import { ErrorBanner } from "@/components/ErrorBanner";
import { MetricCard } from "@/components/MetricCard";
import { useSuccessToast } from "@/components/SuccessToast";

export type AccountOption = { id: string; name: string; currency: string };

type ImportResult = {
  imported: number;
  duplicates: number;
  failed: number;
  warnings: string[];
  errors: Array<{ line: number; reason: string }>;
};

/** Раздел 7.7 — формат вкладками, файл перетаскиванием, результат карточками. */
export function ImportClient({ accounts }: { accounts: AccountOption[] }) {
  const router = useRouter();
  const notify = useSuccessToast();
  const [accountId, setAccountId] = React.useState(accounts[0]?.id ?? "");
  const [provider, setProvider] = React.useState<"csv" | "ofx">("csv");
  const [file, setFile] = React.useState<File | null>(null);
  const [dragging, setDragging] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [result, setResult] = React.useState<ImportResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [showAllErrors, setShowAllErrors] = React.useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setResult(null);
    if (!file) {
      setError("Выберите файл выписки");
      return;
    }
    if (!accountId) {
      setError("Сначала откройте счёт");
      return;
    }
    setPending(true);
    try {
      const form = new FormData();
      form.append("accountId", accountId);
      form.append("provider", provider);
      form.append("file", file);
      const res = await fetch("/api/imports", { method: "POST", body: form });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body?.error?.message ?? "Не удалось импортировать выписку");
        return;
      }
      setResult(body);
      setShowAllErrors(false);
      router.refresh();
      if (body.imported > 0) notify(`Импортировано ${body.imported} операций`);
    } catch {
      setError("Нет связи с сервером. Проверьте подключение и повторите.");
    } finally {
      setPending(false);
    }
  }

  if (accounts.length === 0) {
    return (
      <div className="rounded-xl border border-ink-200 bg-white">
        <EmptyState
          title="Сначала откройте счёт"
          description="Импортированные операции привязываются к счёту"
          action={
            <Button asChild>
              <Link href="/accounts">Открыть счёт</Link>
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4 rounded-xl border border-ink-200 bg-white p-4 md:p-5">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="imp-account">Счёт для импорта</Label>
          <Select value={accountId} onValueChange={setAccountId}>
            <SelectTrigger id="imp-account">
              <SelectValue placeholder="Выберите счёт" />
            </SelectTrigger>
            <SelectContent>
              {accounts.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name} · {a.currency}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label>Формат выписки</Label>
          <Tabs value={provider} onValueChange={(v) => { setProvider(v as "csv" | "ofx"); setFile(null); }}>
            <TabsList className="w-full">
              <TabsTrigger value="csv" className="flex-1">CSV</TabsTrigger>
              <TabsTrigger value="ofx" className="flex-1">OFX / QFX</TabsTrigger>
            </TabsList>
            <TabsContent value="csv" className="sr-only">Формат CSV</TabsContent>
            <TabsContent value="ofx" className="sr-only">Формат OFX</TabsContent>
          </Tabs>
        </div>
      </div>

      <div className="space-y-1">
        <Label htmlFor="imp-file">Файл выписки</Label>
        <label
          htmlFor="imp-file"
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const dropped = e.dataTransfer.files?.[0] ?? null;
            if (dropped) setFile(dropped);
          }}
          className={cn(
            "flex h-40 w-full cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-ink-300 bg-white p-4 text-center",
            dragging && "border-accent-600 bg-accent-50",
          )}
        >
          <UploadCloud className="h-6 w-6 text-ink-400" aria-hidden="true" />
          <span className="text-base text-ink-700">
            {file ? file.name : "Перетащите файл или нажмите, чтобы выбрать"}
          </span>
          <span className="text-xs text-ink-500">
            {provider === "csv" ? "Форматы: 1С, Сбербанк, CSV с колонками date, amount, description" : "Форматы: OFX и QFX"}
          </span>
          <input
            id="imp-file"
            type="file"
            className="sr-only"
            accept={provider === "csv" ? ".csv,text/csv" : ".ofx,.qfx,text/plain"}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </label>
      </div>

      {error ? <ErrorBanner message={error} /> : null}

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button type="submit" disabled={pending} className="w-full sm:w-auto">
          {pending ? "Импортируем…" : "Импортировать"}
        </Button>
        {result && result.imported > 0 ? (
          <Button asChild variant="secondary" className="w-full sm:w-auto">
            <Link href="/operations">Перейти к операциям</Link>
          </Button>
        ) : null}
      </div>

      {result ? <ImportResultView result={result} showAll={showAllErrors} onShowAll={() => setShowAllErrors(true)} /> : null}
    </form>
  );
}

function ImportResultView({
  result,
  showAll,
  onShowAll,
}: {
  result: ImportResult;
  showAll: boolean;
  onShowAll: () => void;
}) {
  const errors = showAll ? result.errors : result.errors.slice(0, 20);
  return (
    <div className="space-y-4 border-t border-ink-200 pt-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <MetricCard label="Импортировано" amount={result.imported} tone="neutral" />
        <MetricCard label="Пропущено дублей" amount={result.duplicates} tone="neutral" />
        <MetricCard label="Ошибок разбора" amount={result.failed} tone="neutral" />
      </div>

      {result.warnings.length > 0 ? (
        <div>
          <div className="mb-1 text-xs text-ink-500">Предупреждения</div>
          <ul className="list-disc space-y-1 pl-5 text-sm text-ink-700">
            {result.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {result.errors.length > 0 ? (
        <div>
          <div className="mb-1 text-xs text-ink-500">Ошибки разбора</div>
          <ul className="list-disc max-h-48 space-y-1 overflow-auto pl-5 text-sm text-ink-700">
            {errors.map((e, i) => (
              <li key={i}>
                строка {e.line}: {e.reason}
              </li>
            ))}
          </ul>
          {!showAll && result.errors.length > 20 ? (
            <Button variant="link" size="sm" className="mt-1 px-0" onClick={onShowAll}>
              показать все ({result.errors.length})
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}