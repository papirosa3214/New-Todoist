// Оценщик JEV — отдельная категория настроек (владелец 16.10.2026: «чтобы я
// мог API ключ вставить … и сам выбирал, где его включать»). Два блока, как
// у Ekko: подключение и сценарии. Каждый сценарий — своя галочка, по
// умолчанию выключен; без ключа галочка ничего не включает.
import { useEffect, useState } from "react";
import {
  Button,
  ErrorBanner,
  FieldGroup,
  ListRow,
  Loading,
  ScreenHeader,
  SectionHeader,
  Switch,
  TextField,
} from "../components/UI";
import { useDialog } from "../components/Dialog";
import {
  useJevSettings,
  useResetJevSettings,
  useSaveJevSettings,
  useTestJev,
  type JevTestResult,
} from "../api/jev";

export function JevScreen() {
  const { data, isLoading, error } = useJevSettings();
  const save = useSaveJevSettings();
  const reset = useResetJevSettings();
  const test = useTestJev();
  const { confirm, dialog } = useDialog();

  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [timeoutMs, setTimeoutMs] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [testResult, setTestResult] = useState<JevTestResult | null>(null);

  useEffect(() => {
    if (!data) return;
    setBaseUrl(data.baseUrl);
    setModel(data.model);
    setTimeoutMs(String(data.timeoutMs));
  }, [data]);

  if (isLoading || !data) return <Loading className="mt-6" />;

  const dirty =
    baseUrl !== data.baseUrl ||
    model !== data.model ||
    timeoutMs !== String(data.timeoutMs) ||
    apiKey.trim() !== "";

  const saveConnection = async () => {
    setTestResult(null);
    await save.mutateAsync({
      baseUrl,
      model,
      timeoutMs: Number(timeoutMs),
      apiKey: apiKey.trim() || undefined,
    });
    setApiKey("");
  };

  const runTest = async () => setTestResult(await test.mutateAsync());

  const removeAll = async () => {
    if (
      !(await confirm(
        "Удалить ключ и сбросить настройки JEV? Все сценарии выключатся.",
      ))
    )
      return;
    setTestResult(null);
    await reset.mutateAsync();
  };

  return (
    <div>
      {dialog}
      <ScreenHeader variant="compact" title="Оценщик JEV" />
      <div className="px-4 space-y-4 max-w-lg mx-auto pt-2 pb-8">
        <p className="tf-action text-sub px-1">
          Выбирает из готовых вариантов то, что подходит задаче. Не отвечает,
          выключен или не уверен — всё работает как без него.
        </p>
        <ErrorBanner
          error={error ?? save.error ?? reset.error ?? test.error}
          variant="block"
        />

        <SectionHeader>Подключение</SectionHeader>
        <FieldGroup>
          <TextField
            icon="link"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="Адрес API"
            aria-label="Адрес API"
          />
          <TextField
            icon="bot"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="Модель"
            aria-label="Модель"
          />
          <TextField
            icon="clock"
            value={timeoutMs}
            onChange={(e) => setTimeoutMs(e.target.value.replace(/\D/g, ""))}
            inputMode="numeric"
            placeholder="Тайм-аут, мс"
            aria-label="Тайм-аут, мс"
            trailing={<span className="tf-action text-dim">мс</span>}
          />
          <TextField
            icon="lock"
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={
              data.hasApiKey
                ? "Ключ сохранён — новый заменит"
                : "Ключ API TypeSafe"
            }
            aria-label="Ключ API"
          />
        </FieldGroup>
        <Button onClick={saveConnection} disabled={!dirty || save.isPending}>
          {save.isPending ? "Сохраняю…" : "Сохранить"}
        </Button>
        <Button
          variant="secondary"
          icon="activity"
          onClick={runTest}
          disabled={!data.hasApiKey || test.isPending || dirty}
        >
          {test.isPending ? "Проверяю…" : "Проверить подключение"}
        </Button>
        {testResult && (
          <p
            className={`tf-action px-1 ${testResult.ok ? "text-teal" : "text-red"}`}
          >
            {testResult.ok
              ? `Подключено за ${testResult.ms} мс. Модели: ${testResult.models.join(", ") || "—"}`
              : `Не подключилось: ${testResult.error}`}
          </p>
        )}

        <SectionHeader>Где использовать</SectionHeader>
        {!data.hasApiKey && (
          <p className="tf-action text-sub px-1">
            Сначала сохраните ключ — без него галочки не включаются.
          </p>
        )}
        <Scenario
          title="Выбор шаблона плана"
          ariaLabel="JEV для выбора шаблона плана"
          checked={data.planProfileEnabled}
          disabled={!data.hasApiKey || save.isPending}
          onChange={(next) => save.mutate({ planProfileEnabled: next })}
        >
          Когда карточке предлагается командный план, JEV выбирает готовый
          состав: один исполнитель, исследование, поставка или полный цикл. Без
          него шаблон выбирается по словам в названии.
        </Scenario>
        <Scenario
          title="Роли для подзадач"
          ariaLabel="JEV для подбора ролей подзадачам"
          checked={data.subtaskRoleEnabled}
          disabled={!data.hasApiKey || save.isPending}
          onChange={(next) => save.mutate({ subtaskRoleEnabled: next })}
        >
          Когда карточка распараллеливается по подзадачам, JEV читает карточку
          целиком и решает по каждой подзадаче: какой роли её отдать и стоит ли
          вообще выносить её отдельно — мелкие пункты остаются исполнителю
          карточки. Где JEV не уверен, роль подбирается как раньше, по смыслу
          текста.
        </Scenario>
        <Scenario
          title="Отбор памяти для роли"
          ariaLabel="JEV для отбора памяти роли"
          checked={data.memoryRecallEnabled}
          disabled={!data.hasApiKey || save.isPending}
          onChange={(next) => save.mutate({ memoryRecallEnabled: next })}
        >
          Перед каждым ходом роль получает записи из памяти команды, похожие на
          её работу. JEV проверяет до 15 найденных: уверенно ненужные убирает,
          полезные ставит вперёд. Закреплённые записи не трогает. Ждёт не
          дольше 3 секунд — иначе память идёт как раньше.
        </Scenario>
        <Scenario
          title="Проверка записи в память"
          ariaLabel="JEV для проверки записи в память"
          checked={data.memoryWriteEnabled}
          disabled={!data.hasApiKey || save.isPending}
          onChange={(next) => save.mutate({ memoryWriteEnabled: next })}
        >
          Когда роль сохраняет факт, урок или предпочтение, JEV проверяет, что
          это знание на будущее, а не разовая деталь текущей работы. Если он
          уверен, что это мусор, запись не сохраняется, и роль получает
          объяснение. Ваши собственные записи не проверяются.
        </Scenario>
        <Scenario
          title="Навыки под задачу"
          ariaLabel="JEV для подбора навыков под задачу"
          checked={data.skillsEnabled}
          disabled={!data.hasApiKey || save.isPending}
          onChange={(next) => save.mutate({ skillsEnabled: next })}
        >
          Когда роль берётся за карточку, она получает не все свои навыки, а
          только нужные этой работе — JEV отбирает их по карточке и текущему
          шагу. Работает у ролей, где навыков больше шести (сейчас — дизайнер и
          разработчик). Если JEV ничего не выбрал или не ответил,
          роль получает все навыки. Явно заданные навыки этапа сохраняются
          независимо от оценки.
        </Scenario>

        <Scenario
          title="Проверка отчётов перед критиком"
          ariaLabel="JEV для предварительной проверки отчётов"
          checked={data.reportReviewEnabled}
          disabled={!data.hasApiKey || save.isPending}
          onChange={(next) => save.mutate({ reportReviewEnabled: next })}
        >
          JEV оценивает связь отчёта с заданием, сведения о проверках и
          ограничения. Критик получает замечания и самостоятельно проверяет
          результат. Оценка JEV не блокирует сдачу.
        </Scenario>
        <Scenario
          title="Намерение сообщения в чате"
          ariaLabel="JEV для распознавания намерения сообщения"
          checked={data.chatIntentEnabled}
          disabled={!data.hasApiKey || save.isPending}
          onChange={(next) => save.mutate({ chatIntentEnabled: next })}
        >
          Помогает роли отличать вопрос, обсуждение, поручение и продолжение
          работы, в том числе внутри текущего хода. Исходное сообщение и
          выбранный режим имеют приоритет; оценка не даёт новых разрешений.
        </Scenario>

        {data.hasApiKey && (
          <Button
            variant="outline"
            icon="trash"
            onClick={removeAll}
            disabled={reset.isPending}
          >
            Удалить ключ и сбросить
          </Button>
        )}
      </div>
    </div>
  );
}

/** Сценарий JEV: строка с галочкой и под ней — что он делает. Описание
 *  отдельным абзацем, а не подписью строки: подпись обрезается по ширине
 *  телефона, а владельцу нужно прочитать его целиком. */
function Scenario({
  title,
  ariaLabel,
  checked,
  disabled,
  onChange,
  children,
}: {
  title: string;
  ariaLabel: string;
  checked: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <FieldGroup>
        <ListRow
          label={title}
          trailing={<Switch ariaLabel={ariaLabel} checked={checked} disabled={disabled} onChange={onChange} />}
        />
      </FieldGroup>
      <p className="tf-action text-sub px-1">{children}</p>
    </div>
  );
}
