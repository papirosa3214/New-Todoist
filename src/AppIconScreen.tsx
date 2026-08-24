import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ScreenHeader, BackButton, Icon } from "../components/UI";
import { APP_ICONS, AppIconsService } from "../lib/appIcons";

export function AppIconScreen() {
  const navigate = useNavigate();
  const [selectedId, setSelectedId] = useState<string>("liquid_glass");
  const [isChanging, setIsChanging] = useState(false);

  useEffect(() => {
    AppIconsService.getCurrentIcon().then(setSelectedId);
  }, []);

  const handleSelectIcon = async (id: string) => {
    if (id === selectedId || isChanging) return;
    setIsChanging(true);
    setSelectedId(id);

    if (typeof window !== "undefined" && (window as any).Capacitor) {
      import("@capacitor/haptics").then(({ Haptics, ImpactStyle }) => {
        Haptics.impact({ style: ImpactStyle.Medium }).catch(() => {});
      });
    }

    try {
      await AppIconsService.setIcon(id);
    } finally {
      setIsChanging(false);
    }
  };

  return (
    <div className="min-h-screen bg-bg text-text pb-12">
      <ScreenHeader
        variant="compact"
        leading={<BackButton onClick={() => navigate(-1)} />}
        title="Иконка приложения"
      />

      <div className="px-4 space-y-4 max-w-lg mx-auto pt-2">
        <div className="text-xs text-sub px-1">
          Выберите стиль иконки для рабочего стола iPhone и приложения:
        </div>

        <div className="space-y-3">
          {APP_ICONS.map((icon) => {
            const isSelected = selectedId === icon.id;
            return (
              <button
                key={icon.id}
                onClick={() => handleSelectIcon(icon.id)}
                className={`w-full p-3.5 rounded-2xl border transition-all text-left flex items-center gap-4 bg-card active:scale-[0.98] ${
                  isSelected
                    ? "border-coral ring-1 ring-coral/50 shadow-md shadow-coral/10"
                    : "border-stroke/50 hover:border-stroke/80 shadow-2xs"
                }`}
              >
                <div className="w-16 h-16 rounded-2xl overflow-hidden shrink-0 border border-white/10 shadow-md bg-black">
                  <img
                    src={icon.image}
                    alt={icon.name}
                    className="w-full h-full object-cover"
                  />
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[15px] font-semibold text-text truncate">
                      {icon.name}
                    </div>
                    {isSelected && (
                      <div className="w-5 h-5 rounded-full bg-coral text-white flex items-center justify-center shrink-0">
                        <Icon name="check" size={12} />
                      </div>
                    )}
                  </div>
                  <div className="text-xs text-sub mt-0.5 leading-snug">
                    {icon.subtitle}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
