import { describe, it, expect } from "vitest";
import { csvProvider } from "../src/importers/csv";

describe("csvProvider", () => {
  it("разбирает 1СClientBankExchange с ;", async () => {
    const content = [
      "СекцияДокумент=Платежное поручение",
      "01.10.2026;01.10.2026;-1500,00;Иванов И.И.;Оплата по договору 12",
      "02.10.2026;02.10.2026;50000,00;ООО Зарплата;Зарплата за сентябрь",
      "КонецФайла",
    ].join("\n");
    const out = await csvProvider.parse(content);
    expect(out.operations).toHaveLength(2);
    expect(out.operations[0].amount).toBeCloseTo(-1500);
    expect(out.operations[0].date).toBe("2026-10-01");
    expect(out.operations[1].amount).toBeCloseTo(50000);
    expect(out.operations[1].date).toBe("2026-10-02");
    expect(out.summary.failed).toBe(0);
  });

  it("разбирает Сбербанк CSV", async () => {
    const content = [
      "Дата операции;Дата обработки;Описание;Сумма в валюте операции;Валюта",
      "03.10.2026;03.10.2026;Пятёрочка;-1 234,56;RUB",
      "04.10.2026;04.10.2026;Зарплата;120000,00;RUB",
    ].join("\n");
    const out = await csvProvider.parse(content);
    expect(out.operations).toHaveLength(2);
    expect(out.operations[0].amount).toBeCloseTo(-1234.56);
    expect(out.operations[0].description).toContain("Пятёрочка");
  });

  it("разбирает generic CSV с заголовком date,amount,description", async () => {
    const content = [
      "date,amount,description,merchant",
      "2026-10-05,-100.50,кофе,Кофейня",
      "2026-10-06,5000,премия,Работодатель",
    ].join("\n");
    const out = await csvProvider.parse(content);
    expect(out.operations).toHaveLength(2);
    expect(out.operations[0].amount).toBeCloseTo(-100.5);
    expect(out.operations[0].merchant).toBe("Кофейня");
    expect(out.operations[1].amount).toBe(5000);
  });

  it("собирает ошибки на битых суммах", async () => {
    const content = [
      "date,amount,description",
      "2026-10-05,NaN,что-то",
      "2026-10-06,-200,нормальная",
    ].join("\n");
    const out = await csvProvider.parse(content);
    expect(out.operations).toHaveLength(1);
    expect(out.summary.failed).toBe(1);
  });

  it("возвращает предупреждение при пустом файле", async () => {
    const out = await csvProvider.parse("");
    expect(out.operations).toHaveLength(0);
    expect(out.warnings.length).toBeGreaterThan(0);
  });
});