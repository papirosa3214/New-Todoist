// Редактор вкладок контекста запуска роли (карточка 15c2db1f, дизайн §9).
//
// Слева — переключатель режима (work / reply / review / chat / voice /
// subtask), справа — список слоёв, попавших в этот режим. У каждого
// слоя: имя, источник (db/file/code/yaml), эффективный текст,
// версия, кнопки «Изменить» / «Сброс» / «История». read_only слои —
// только просмотр и ссылка «правится здесь» (экран моделей, профиль
// Pi и т.п.). Конфликт версий (HTTP 409) сохраняет draft в
// sessionStorage, владелец решает «обновить и применить».
//
// UI без декоративного редизайна: используем существующие компоненты
// (BottomSheet, Icon, Loading, ErrorBanner).

import { useEffect, useMemo, useState } from "react";
import { ErrorBanner, Icon, Loading, SheetHandle } from "./UI";
import { useBottomSheet } from "../lib/useBottomSheet";
import type { RoleDetails } from "../api/roles";

type RunMode = "work" | "reply" | "review" | "chat" | "voice" | "subtask";

type ComposedLayer = {
  layer: string;
  effective: string;
  source: "override" | "command_default" | "original";
  origin: { kind: string; ref: string };
  version: number;
  updated_at: string | null;
  updated_by: string | null;
  read_only: boolean;
  modes: ReadonlyArray<string>;
};

type ComposedResponse = {
  role: string;
  mode: RunMode;
  version: number;
  layers: ComposedLayer[];
};

const MODES: Array<{ key: RunMode; title: string }> = [
  { key: "work", title: "Задача" },
  { key: "reply", title: "Ответ" },
  { key: "review", title: "Ревью" },
  { key: "chat", title: "Чат" },
  { key: "voice", title: "Голос" },
  { key: "subtask", title: "План" },
];

interface HistoryEntry {
  version: number;
  action: "set" | "reset" | "restore";
  at: string;
  byUserId: string;
  reason: string | null;
}

function draftKey(role: string, layer: string): string {
  return `taskflow-context.draft.${role}.${layer}`;
}

function versionKey(role: string, layer: string): string {
  return `taskflow-context.ifmatch.${role}.${layer}`;
}

export function RoleContextSheet({
  open,
  onClose,
  role,
  apiBase,
  token,
}: {
  open: boolean;
  onClose: () => void;
  role: RoleDetails;
  apiBase: string;
  token: string | null;
}) {
  const sheet = useBottomSheet({ open, onClose });
  const [mode, setMode] = useState<RunMode>("work");
  const [data, setData] = useState<ComposedResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingLayer, setEditingLayer] = useState<string | null>(null);
  const [historyLayer, setHistoryLayer] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);

  const reload = useMemo(
    () => async (m: RunMode) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `${apiBase}/api/runtime/context?role=${encodeURIComponent(role.role)}&mode=${m}`,
          { headers: token ? { authorization: `Bearer ${token}` } : {} },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as ComposedResponse;
        setData(json);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [apiBase, role.role, token],
  );

  useEffect(() => {
    if (!open || !sheet.mounted) return;
    void reload(mode);
  }, [mode, open, reload, sheet.mounted]);

  if (!sheet.mounted) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col justify-end"
      aria-modal="true"
      role="dialog"
    >
      <div
        ref={sheet.scrimRef}
        onClick={onClose}
        className="absolute inset-0 bg-black/40"
      />
      <div
        ref={sheet.sheetRef}
        className="relative bg-card rounded-sheet-top px-4 pb-bottom-safe max-h-[88vh] overflow-y-auto"
      >
        <SheetHandle dragProps={sheet.dragProps} />
        <h3 className="text-[16px] text-text font-semibold px-1 mb-1">
          Контекст запуска: {role.title}
        </h3>
        <p className="text-[12px] text-sub px-1 mb-3">
          Что модель реально получит при старте в выбранном режиме.
        </p>

        {/* Переключатель режимов */}
        <div className="flex flex-wrap gap-2 px-1 mb-3">
          {MODES.map((m) => (
            <button
              key={m.key}
              type="button"
              onClick={() => setMode(m.key)}
              className={`tap-scale h-9 px-3 rounded-xl text-[13px] ${
                m.key === mode
                  ? "bg-red text-white font-semibold"
                  : "bg-card2 text-sub"
              }`}
            >
              {m.title}
            </button>
          ))}
        </div>

        <ErrorBanner error={error} variant="block" className="mb-2" />

        {loading && <Loading className="mb-3" />}

        {data && !loading && (
          <div className="space-y-2 px-1 pb-2">
            {data.layers.map((layer) => (
              <LayerRow
                key={layer.layer}
                layer={layer}
                role={role.role}
                apiBase={apiBase}
                token={token}
                editing={editingLayer === layer.layer}
                onStartEdit={() => setEditingLayer(layer.layer)}
                onCancelEdit={() => setEditingLayer(null)}
                onSaved={() => {
                  setEditingLayer(null);
                  void reload(mode);
                }}
                onReset={async () => {
                  await resetLayer(apiBase, token, role.role, layer.layer);
                  void reload(mode);
                }}
                onShowHistory={async () => {
                  setHistoryLayer(layer.layer);
                  const h = await fetchHistory(
                    apiBase,
                    token,
                    role.role,
                    layer.layer,
                  );
                  setHistory(h);
                }}
                onRestore={async (v) => {
                  await restoreLayer(
                    apiBase,
                    token,
                    role.role,
                    layer.layer,
                    v,
                  );
                  setHistoryLayer(null);
                  setHistory(null);
                  void reload(mode);
                }}
                showHistory={historyLayer === layer.layer}
                history={history}
                onCloseHistory={() => {
                  setHistoryLayer(null);
                  setHistory(null);
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function LayerRow({
  layer,
  role,
  apiBase,
  token,
  editing,
  onStartEdit,
  onCancelEdit,
  onSaved,
  onReset,
  onShowHistory,
  onRestore,
  showHistory,
  history,
  onCloseHistory,
}: {
  layer: ComposedLayer;
  role: string;
  apiBase: string;
  token: string | null;
  editing: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaved: () => void;
  onReset: () => void | Promise<void>;
  onShowHistory: () => void | Promise<void>;
  onRestore: (v: number) => void | Promise<void>;
  showHistory: boolean;
  history: HistoryEntry[] | null;
  onCloseHistory: () => void;
}) {
  const [draft, setDraft] = useState<string>(layer.effective);
  const [conflict, setConflict] = useState<ComposedLayer | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const sourceLabel = (() => {
    switch (layer.source) {
      case "override":
        return "правка владельца";
      case "command_default":
        return "общая инструкция";
      case "original":
      default:
        return "исходный текст";
    }
  })();

  const save = async () => {
    setSubmitting(true);
    setConflict(null);
    try {
      const ifMatch =
        Number(sessionStorage.getItem(versionKey(role, layer.layer))) ||
        layer.version;
      const res = await fetch(
        `${apiBase}/api/runtime/context/${encodeURIComponent(role)}/${encodeURIComponent(layer.layer)}`,
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            "if-match": `"${ifMatch}"`,
          },
          body: JSON.stringify({ text: draft, if_match: ifMatch }),
        },
      );
      if (res.status === 409) {
        const body = (await res.json()) as { current: ComposedLayer };
        setConflict(body.current);
        sessionStorage.setItem(draftKey(role, layer.layer), draft);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      sessionStorage.removeItem(draftKey(role, layer.layer));
      onSaved();
    } catch (err) {
      setConflict({
        ...layer,
        effective: `Ошибка: ${(err as Error).message}`,
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="bg-card2 rounded-xl p-3">
      <div className="flex items-baseline gap-2 mb-1">
        <span className="text-[13px] text-text font-semibold">{layer.layer}</span>
        <span className="text-[11px] text-dim">v{layer.version}</span>
        <span className="ml-auto text-[11px] text-sub">{sourceLabel}</span>
      </div>
      <p className="text-[11px] text-dim mb-2">{layer.origin.ref}</p>

      {editing ? (
        <div>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="w-full h-32 bg-card rounded-lg p-2 text-[12px] text-text border border-card2 resize-y"
          />
          {conflict && (
            <div className="bg-card rounded-lg p-2 mt-2 text-[12px] text-sub">
              <p className="mb-1">
                Версия не совпала: текущая v{conflict.version}. Сохранилось в
                черновик, можешь обновить и применить.
              </p>
              <button
                type="button"
                onClick={() => {
                  sessionStorage.setItem(
                    versionKey(role, layer.layer),
                    String(conflict.version),
                  );
                  setDraft(conflict.effective);
                  setConflict(null);
                }}
                className="tap-scale h-8 px-3 rounded-lg bg-red text-white text-[12px]"
              >
                Обновить и применить
              </button>
            </div>
          )}
          <div className="flex gap-2 mt-2">
            <button
              type="button"
              onClick={save}
              disabled={submitting}
              className="tap-scale h-9 px-3 rounded-lg bg-red text-white text-[13px] font-semibold disabled:opacity-50"
            >
              {submitting ? "Сохранение…" : "Сохранить"}
            </button>
            <button
              type="button"
              onClick={onCancelEdit}
              className="tap-scale h-9 px-3 rounded-lg bg-card2 text-sub text-[13px]"
            >
              Отмена
            </button>
          </div>
        </div>
      ) : (
        <>
          <pre className="text-[12px] text-sub whitespace-pre-wrap line-clamp-5 mb-2">
            {layer.effective || "(пусто)"}
          </pre>
          <div className="flex gap-2 flex-wrap">
            {!layer.read_only && (
              <button
                type="button"
                onClick={onStartEdit}
                className="tap-scale h-8 px-3 rounded-lg bg-card text-text text-[12px] font-semibold flex items-center gap-1"
              >
                <Icon name="edit" size={14} className="text-sub" />
                Изменить
              </button>
            )}
            {!layer.read_only && layer.version > 0 && (
              <button
                type="button"
                onClick={onReset}
                className="tap-scale h-8 px-3 rounded-lg bg-card text-text text-[12px] flex items-center gap-1"
              >
                <Icon name="refresh" size={14} className="text-sub" />
                Сброс
              </button>
            )}
            <button
              type="button"
              onClick={showHistory ? onCloseHistory : onShowHistory}
              className="tap-scale h-8 px-3 rounded-lg bg-card text-text text-[12px] flex items-center gap-1"
            >
              <Icon name="clock" size={14} className="text-sub" />
              История
            </button>
          </div>

          {showHistory && history && (
            <div className="mt-3 bg-card rounded-lg p-2">
              {history.length === 0 ? (
                <p className="text-[12px] text-sub">История пуста</p>
              ) : (
                <ul className="space-y-1">
                  {history.map((h) => (
                    <li
                      key={`${h.at}-${h.version}`}
                      className="text-[12px] text-sub flex items-center gap-2"
                    >
                      <span className="font-mono">v{h.version}</span>
                      <span className="text-dim">{h.action}</span>
                      <span className="ml-auto">{h.at}</span>
                      {h.version !== layer.version && (
                        <button
                          type="button"
                          onClick={() => onRestore(h.version)}
                          className="tap-scale h-7 px-2 rounded bg-card2 text-text"
                        >
                          Восстановить
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

async function resetLayer(
  apiBase: string,
  token: string | null,
  role: string,
  layer: string,
): Promise<void> {
  await fetch(
    `${apiBase}/api/runtime/context/${encodeURIComponent(role)}/${encodeURIComponent(layer)}/reset`,
    {
      method: "POST",
      headers: token ? { authorization: `Bearer ${token}` } : {},
    },
  );
}

async function restoreLayer(
  apiBase: string,
  token: string | null,
  role: string,
  layer: string,
  version: number,
): Promise<void> {
  await fetch(
    `${apiBase}/api/runtime/context/${encodeURIComponent(role)}/${encodeURIComponent(layer)}/restore`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ version }),
    },
  );
}

async function fetchHistory(
  apiBase: string,
  token: string | null,
  role: string,
  layer: string,
): Promise<HistoryEntry[]> {
  const res = await fetch(
    `${apiBase}/api/runtime/context/${encodeURIComponent(role)}/${encodeURIComponent(layer)}`,
    { headers: token ? { authorization: `Bearer ${token}` } : {} },
  );
  if (!res.ok) return [];
  const body = (await res.json()) as { history: HistoryEntry[] };
  return body.history ?? [];
}