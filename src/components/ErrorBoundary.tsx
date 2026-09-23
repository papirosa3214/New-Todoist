// ═══════════ React ErrorBoundary ═══════════
//
// Карточка 70697681 (19.09.2026): «Собрать задачи» в заметках падает
// с белым экраном. Серверная часть в порядке, ручные вызовы
// /api/ai/extract-tasks возвращают 200 — падение случается на клиенте
// при странной форме ответа: `tasks.map(...)` без проверки на undefined
// выбрасывает TypeError прямо в render-phase, до ErrorBanner никто не
// доходит, до React-границы ошибки не доходят, потому что её не было.
//
// До правки: одна необработанная ошибка в любом дочернем экране
// «роняла» всё приложение в белый экран. На iOS-натив клиенте через
// Capacitor это выглядело как возврат на рабочий стол.
//
// После правки: ErrorBoundary ловит любой непойманный throw в дереве,
// показывает внятное сообщение с кнопкой «Попробовать снова» (reload
// состояния) вместо белого экрана, и в консоль пишет полный стек —
// чтобы при следующей репродукции сразу было видно, что и где.
import { Component, type ErrorInfo, type ReactNode } from "react";
import { Icon } from "./UI";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Полный стек — в консоль браузера / WKWebView / Xcode console,
    // чтобы воспроизведение бага оставляло след. Само сообщение для
    // пользователя — общее, без технических деталей (см. render()).
    // eslint-disable-next-line no-console
    console.error("[ErrorBoundary] Непойманная ошибка:", error, info);
  }

  private handleReset = () => {
    this.setState({ error: null });
  };

  private handleReload = () => {
    window.location.reload();
  };

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="min-h-[100dvh] flex flex-col items-center justify-center gap-4 px-6 text-center bg-bg">
          <div className="w-16 h-16 rounded-full bg-card flex items-center justify-center">
            <Icon name="info" size={28} className="text-coral" />
          </div>
          <div>
            <h1 className="text-[19px] font-semibold text-text mb-1">
              Что-то пошло не так
            </h1>
            <p className="text-[14px] text-sub leading-relaxed max-w-[320px]">
              Экран не смог отрисоваться. Попробуйте вернуться назад или
              перезагрузить приложение — если ошибка повторится, опишите
              шаги в чате.
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={this.handleReset}
              className="h-11 px-5 rounded-xl bg-card text-[14px] font-medium text-text"
            >
              Назад
            </button>
            <button
              onClick={this.handleReload}
              className="h-11 px-5 rounded-xl bg-red text-[14px] font-semibold text-white"
            >
              Перезагрузить
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
