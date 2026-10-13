"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export type AccountOption = { id: string; name: string; currency: string };

export function ImportClient({ accounts }: { accounts: AccountOption[] }) {
  const router = useRouter();
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [provider, setProvider] = useState<"csv" | "ofx">("csv");
  const [file, setFile] = useState<File | null>(null);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<null | {
    imported: number;
    duplicates: number;
    failed: number;
    warnings: string[];
    errors: Array<{ line: number; reason: string }>;
  }>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setResult(null);
    if (!file) {
      setError("Выберите файл");
      return;
    }
    if (!accountId) {
      setError("Создайте счёт для импорта");
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
        setError(body?.error?.message ?? "Не удалось импортировать");
        setPending(false);
        return;
      }
      setResult(body);
      setPending(false);
      router.refresh();
    } catch {
      setError("Сетевая ошибка");
      setPending(false);
    }
  }

  if (accounts.length === 0) {
    return (
      <div className="bg-yellow-50 border border-yellow-200 rounded-md p-4 text-sm">
        Сначала{" "}
        <a className="text-accent-600 underline" href="/accounts">
          создайте счёт
        </a>
        , к которому будут привязаны импортированные операции.
      </div>
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      className="bg-white border border-ink-200 rounded-xl p-4 space-y-4"
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="block">
          <span className="text-sm text-ink-700">Счёт для импорта</span>
          <select
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            className="mt-1 w-full border border-ink-300 rounded-md px-3 py-2 text-sm"
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.currency})
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-sm text-ink-700">Формат</span>
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value as "csv" | "ofx")}
            className="mt-1 w-full border border-ink-300 rounded-md px-3 py-2 text-sm"
          >
            <option value="csv">CSV (1С / Сбербанк / generic)</option>
            <option value="ofx">OFX / QFX</option>
          </select>
        </label>
      </div>
      <label className="block">
        <span className="text-sm text-ink-700">Файл</span>
        <input
          type="file"
          accept={provider === "csv" ? ".csv,text/csv" : ".ofx,.qfx,text/plain"}
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="mt-1 w-full border border-ink-300 rounded-md px-3 py-2 text-sm bg-white"
        />
      </label>
      {error ? <p className="text-sm text-danger-500">{error}</p> : null}
      <button
        type="submit"
        disabled={pending}
        className="bg-accent-600 text-white text-sm rounded-md px-4 py-2 hover:bg-accent-700 disabled:opacity-60"
      >
        {pending ? "Импортируем…" : "Импортировать"}
      </button>

      {result ? <ImportResult result={result} /> : null}
    </form>
  );
}

function ImportResult({
  result,
}: {
  result: {
    imported: number;
    duplicates: number;
    failed: number;
    warnings: string[];
    errors: Array<{ line: number; reason: string }>;
  };
}) {
  return (
    <div className="border-t border-ink-200 pt-4 mt-4 text-sm space-y-2">
      <div className="flex gap-6">
        <div>
          <div className="text-xs text-ink-500">Импортировано новых</div>
          <div className="text-lg font-semibold text-accent-700">{result.imported}</div>
        </div>
        <div>
          <div className="text-xs text-ink-500">Дублей пропущено</div>
          <div className="text-lg font-semibold">{result.duplicates}</div>
        </div>
        <div>
          <div className="text-xs text-ink-500">Ошибок</div>
          <div className="text-lg font-semibold text-danger-500">{result.failed}</div>
        </div>
      </div>
      {result.warnings.length > 0 ? (
        <div>
          <div className="text-xs text-ink-500 mb-1">Предупреждения:</div>
          <ul className="list-disc pl-5 text-ink-700">
            {result.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {result.errors.length > 0 ? (
        <div>
          <div className="text-xs text-ink-500 mb-1">Ошибки разбора:</div>
          <ul className="list-disc pl-5 text-ink-700 max-h-48 overflow-auto">
            {result.errors.slice(0, 50).map((e, i) => (
              <li key={i}>
                строка {e.line}: {e.reason}
              </li>
            ))}
            {result.errors.length > 50 ? (
              <li>… ещё {result.errors.length - 50}</li>
            ) : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}