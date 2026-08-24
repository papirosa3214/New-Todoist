import { useAppStore, AI_PROVIDERS, type AiProviderType } from "../store";
import { useLocalOllamaModels } from "../api/ai";
import { hapticTap, hapticSuccess } from "../lib/haptics";
import { 
  X, 
  Check, 
  Server, 
  Brain, 
  Sparkles, 
  Zap, 
  Cpu, 
  Bot,
  ShieldCheck
} from "lucide-react";

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

export function AiProviderModal({ isOpen, onClose }: Props) {
  const currentProvider = useAppStore((s) => s.aiProvider);
  const setProvider = useAppStore((s) => s.setAiProvider);
  const currentLocalModel = useAppStore((s) => s.localOllamaModel);
  const setLocalModel = useAppStore((s) => s.setLocalOllamaModel);
  const { data: localModelsData } = useLocalOllamaModels();

  if (!isOpen) return null;

  const getProviderIcon = (id: AiProviderType) => {
    switch (id) {
      case "local":
        return <Server className="w-5 h-5" />;
      case "claude":
        return <Brain className="w-5 h-5" />;
      case "hermes":
        return <Sparkles className="w-5 h-5" />;
      case "antigravity":
        return <Zap className="w-5 h-5" />;
      case "deepseek":
        return <Cpu className="w-5 h-5" />;
      default:
        return <Bot className="w-5 h-5" />;
    }
  };

  const handleSelect = (id: AiProviderType) => {
    hapticSuccess();
    setProvider(id);
    if (id !== "local") {
      setTimeout(() => {
        onClose();
      }, 200);
    }
  };

  const handleSelectLocalModel = (modelName: string, e: React.MouseEvent) => {
    e.stopPropagation();
    hapticSuccess();
    setLocalModel(modelName);
  };

  const availableModels = localModelsData?.models?.length 
    ? localModelsData.models.map((m) => m.name)
    : ["coder30b-abl:latest", "qwen3.6-27b-iq4-16k:latest", "qwen2.5-14b-credit-risk:latest"];

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 select-none safe-area-all">
      {/* Backdrop */}
      <div 
        onClick={onClose}
        className="absolute inset-0 bg-black/75 backdrop-blur-md transition-opacity animate-fade-in"
      />

      {/* Sheet / Dialog Modal */}
      <div className="relative w-full max-w-md bg-[#1C1C1E] border border-white/10 rounded-[28px] shadow-2xl flex flex-col overflow-hidden animate-scale-up text-white">
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-white/10">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-2xl bg-gradient-to-tr from-[#3B82F6] to-[#8B5CF6] flex items-center justify-center shadow-md shadow-[#8B5CF6]/30">
              <Bot className="w-5 h-5 text-white" />
            </div>
            <div>
              <h2 className="text-[17px] font-bold tracking-tight text-white">
                AI Ассистент и Модели
              </h2>
              <p className="text-[11px] text-white/50">Выберите основной мозг и модель для задач</p>
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

        {/* Providers List */}
        <div className="p-4 space-y-2.5 max-h-[65vh] overflow-y-auto">
          {(Object.keys(AI_PROVIDERS) as AiProviderType[]).map((key) => {
            const item = AI_PROVIDERS[key];
            const isSelected = currentProvider === key;

            return (
              <div key={key} className="flex flex-col">
                <div
                  onClick={() => handleSelect(key)}
                  className={`p-3.5 rounded-2xl border transition-all cursor-pointer flex items-center justify-between gap-3 active:scale-[0.98] ${
                    isSelected
                      ? "bg-white/[0.08] border-white/30 shadow-lg shadow-black/40"
                      : "bg-white/[0.03] border-white/5 hover:bg-white/[0.05] text-white/80"
                  }`}
                >
                  <div className="flex items-center gap-3.5 min-w-0">
                    <div 
                      className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 shadow-sm"
                      style={{ backgroundColor: `${item.color}20`, color: item.color }}
                    >
                      {getProviderIcon(key)}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[15px] font-semibold text-white truncate">
                          {item.name}
                        </span>
                        <span 
                          className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full border shrink-0"
                          style={{ 
                            backgroundColor: `${item.color}15`, 
                            borderColor: `${item.color}40`,
                            color: item.color 
                          }}
                        >
                          {item.badge}
                        </span>
                      </div>
                      <div className="text-[12px] text-white/50 truncate mt-0.5">
                        {item.subtitle}
                      </div>
                    </div>
                  </div>

                  <div 
                    className={`w-6 h-6 rounded-full border flex items-center justify-center shrink-0 transition-colors ${
                      isSelected
                        ? "bg-[#34C759] border-[#34C759] text-white"
                        : "border-white/20 text-transparent"
                    }`}
                  >
                    <Check className="w-3.5 h-3.5" />
                  </div>
                </div>

                {/* Sub-selector for Local Ollama Models */}
                {key === "local" && isSelected && (
                  <div className="mt-2 ml-4 pl-4 border-l-2 border-white/10 space-y-1.5 py-1">
                    <div className="text-[11px] font-semibold text-white/40 uppercase tracking-wider mb-1">
                      Модель на 192.168.1.110:
                    </div>
                    {availableModels.map((mName) => {
                      const isModelActive = (currentLocalModel || "coder30b-abl:latest") === mName;
                      const isFast = mName.includes("coder");
                      const isReasoning = mName.includes("27b");
                      
                      return (
                        <div
                          key={mName}
                          onClick={(e) => handleSelectLocalModel(mName, e)}
                          className={`p-2.5 rounded-xl border flex items-center justify-between gap-2 text-[12px] cursor-pointer transition-all active:scale-98 ${
                            isModelActive
                              ? "bg-[#34C759]/15 border-[#34C759]/40 text-white font-medium shadow-sm"
                              : "bg-white/[0.02] border-white/5 hover:bg-white/[0.05] text-white/70"
                          }`}
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-[13px]">{isFast ? "⚡" : isReasoning ? "🧠" : "🤖"}</span>
                            <span className="truncate">{mName}</span>
                            {isFast && (
                              <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#34C759]/20 text-[#34C759] font-bold">
                                Быстрая
                              </span>
                            )}
                            {isReasoning && (
                              <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#8B5CF6]/20 text-[#8B5CF6] font-bold">
                                Думающая
                              </span>
                            )}
                          </div>
                          {isModelActive && <Check className="w-3.5 h-3.5 text-[#34C759] shrink-0" />}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Footer Note */}
        <div className="px-5 py-3 border-t border-white/10 bg-black/20 text-[11px] text-white/40 flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-[#34C759] shrink-0" />
          <span>Диктовка голосом остаётся на быстром выделенном ASR Whisper</span>
        </div>
      </div>
    </div>
  );
}
