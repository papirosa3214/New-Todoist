import { useWeeklySummary, useRefreshWeeklySummary } from "../api/ai";
import { hapticTap, hapticSuccess, hapticError } from "../lib/haptics";
import {
  X,
  CheckCircle2,
  AlertTriangle,
  Target,
  RefreshCw,
  Zap,
  BrainCircuit,
} from "lucide-react";

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

export function WeeklySummaryModal({ isOpen, onClose }: Props) {
  const { data: summary, isLoading, isError, error } = useWeeklySummary();
  const refreshMutation = useRefreshWeeklySummary();

  const handleRefresh = () => {
    hapticTap();
    refreshMutation.mutate(undefined, {
      onSuccess: () => hapticSuccess(),
      onError: () => hapticError(),
    });
  };

  if (!isOpen) return null;

  const isBusy = isLoading || refreshMutation.isPending;

  return (
    <div
      // Свайп «назад» не должен уводить экран из-под шторки
      // (useSwipeBack ищет этот атрибут).
      data-overlay
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 select-none safe-area-all"
    >
      {/* Backdrop */}
      <div
        onClick={onClose}
        className="absolute inset-0 bg-black/75 backdrop-blur-md transition-opacity animate-fade-in"
      />

      {/* Sheet / Dialog Modal */}
      <div className="relative w-full max-w-lg max-h-[85vh] bg-[#1C1C1E] border border-white/10 rounded-[28px] shadow-2xl flex flex-col overflow-hidden animate-scale-up text-white">
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-white/10">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-2xl bg-gradient-to-tr from-[#FF2D55] to-[#FF9500] flex items-center justify-center shadow-md shadow-[#FF2D55]/30">
              <BrainCircuit className="w-5 h-5 text-white" />
            </div>
            <div>
              <h2 className="text-[17px] font-bold tracking-tight text-white flex items-center gap-2">
                Сводка недели
                <span className="text-[10px] font-semibold tracking-wider uppercase px-2 py-0.5 rounded-full bg-white/10 text-white/70">
                  Second Brain
                </span>
              </h2>
              <p className="text-[11px] text-white/50">
                Анализ продуктивности и фокус на цели
              </p>
            </div>
          </div>

          <button
            onClick={() => {
              hapticTap();
              onClose();
            }}
            className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center text-white/70 hover:text-white active:scale-95 transition-transform"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {isBusy ? (
            <div className="flex flex-col items-center justify-center py-16 text-center space-y-3">
              <div className="w-12 h-12 rounded-full border-3 border-[#FF2D55]/30 border-t-[#FF2D55] animate-spin mb-2" />
              <div className="text-[15px] font-semibold text-white">
                AI анализирует вашу неделю...
              </div>
              <div className="text-[12px] text-white/50 max-w-xs">
                Локальная нейросеть сводит победы, просрочки и строит главные
                приоритеты
              </div>
            </div>
          ) : isError && !summary ? (
            <div className="p-4 rounded-2xl bg-red/10 border border-red/20 text-center text-[13px] text-red-400">
              {String(
                (error as any)?.message ||
                  "Не удалось загрузить сводку. Проверьте сервер.",
              )}
            </div>
          ) : summary ? (
            <>
              {/* Score & Greeting Banner */}
              <div className="p-4 rounded-2xl bg-gradient-to-br from-white/[0.08] to-white/[0.03] border border-white/10 shadow-sm">
                <div className="flex items-center justify-between mb-2.5">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-[#FF9500]">
                    <Zap className="w-4 h-4 fill-[#FF9500]" />
                    <span>Продуктивность</span>
                  </div>
                  <div className="text-sm font-bold px-2.5 py-0.5 rounded-full bg-[#FF9500]/20 text-[#FF9500] border border-[#FF9500]/30">
                    {summary.productivity_score}%
                  </div>
                </div>
                <p className="text-[14px] text-white/90 leading-snug font-medium">
                  {summary.greeting}
                </p>
              </div>

              {/* Stats Counters */}
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="p-3 rounded-xl bg-white/[0.04] border border-white/5">
                  <div className="text-[18px] font-bold text-[#34C759]">
                    {summary.stats.completed_count}
                  </div>
                  <div className="text-[11px] text-white/50">Сделано</div>
                </div>
                <div className="p-3 rounded-xl bg-white/[0.04] border border-white/5">
                  <div className="text-[18px] font-bold text-[#FF453A]">
                    {summary.stats.overdue_count}
                  </div>
                  <div className="text-[11px] text-white/50">Просрочено</div>
                </div>
                <div className="p-3 rounded-xl bg-white/[0.04] border border-white/5">
                  <div className="text-[18px] font-bold text-[#0A84FF]">
                    {summary.stats.active_count}
                  </div>
                  <div className="text-[11px] text-white/50">В работе</div>
                </div>
              </div>

              {/* Section 1: Accomplishments */}
              {summary.accomplishments.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-[13px] font-semibold text-[#34C759] uppercase tracking-wider">
                    <CheckCircle2 className="w-4 h-4" />
                    <span>Главные победы недели</span>
                  </div>
                  <div className="p-3.5 rounded-2xl bg-[#34C759]/10 border border-[#34C759]/20 space-y-2">
                    {summary.accomplishments.map((item, idx) => (
                      <div
                        key={idx}
                        className="flex items-start gap-2.5 text-[13px] text-white/90 leading-snug"
                      >
                        <span className="text-[#34C759] font-bold mt-0.5">
                          •
                        </span>
                        <span>{item}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Section 2: Missed & Overdue */}
              {summary.missed_or_overdue.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-[13px] font-semibold text-[#FF453A] uppercase tracking-wider">
                    <AlertTriangle className="w-4 h-4" />
                    <span>Где просели / долги и хвосты</span>
                  </div>
                  <div className="p-3.5 rounded-2xl bg-[#FF453A]/10 border border-[#FF453A]/20 space-y-2">
                    {summary.missed_or_overdue.map((item, idx) => (
                      <div
                        key={idx}
                        className="flex items-start gap-2.5 text-[13px] text-white/90 leading-snug"
                      >
                        <span className="text-[#FF453A] font-bold mt-0.5">
                          !
                        </span>
                        <span>{item}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Section 3: Next Week Focus */}
              {summary.next_week_focus.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-[13px] font-semibold text-[#0A84FF] uppercase tracking-wider">
                    <Target className="w-4 h-4" />
                    <span>Фокус на следующую неделю</span>
                  </div>
                  <div className="p-3.5 rounded-2xl bg-[#0A84FF]/10 border border-[#0A84FF]/20 space-y-2">
                    {summary.next_week_focus.map((item, idx) => (
                      <div
                        key={idx}
                        className="flex items-start gap-2.5 text-[13px] text-white/90 leading-snug"
                      >
                        <span className="text-[#0A84FF] font-bold mt-0.5">
                          →
                        </span>
                        <span>{item}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : null}
        </div>

        {/* Footer actions */}
        <div className="px-5 py-3.5 border-t border-white/10 bg-black/20 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isBusy}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white/10 hover:bg-white/15 active:scale-95 text-[13px] font-medium text-white transition-all disabled:opacity-50"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${refreshMutation.isPending ? "animate-spin" : ""}`}
            />
            <span>Обновить сводку</span>
          </button>

          <button
            type="button"
            onClick={() => {
              hapticTap();
              onClose();
            }}
            className="px-5 py-2.5 rounded-xl bg-white text-black font-semibold text-[13px] active:scale-95 transition-transform"
          >
            Закрыть
          </button>
        </div>
      </div>
    </div>
  );
}
