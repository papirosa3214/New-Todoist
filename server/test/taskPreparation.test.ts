import { describe, expect, it } from "vitest";
import { validatePreparation, NonTaskInputError } from "../src/lib/taskPreparation.js";
const stream = (key:string, role:string, dependencies:string[] = [], parallel:string[] = []) => ({key,title:key,result:`Результат ${key}`,role,depends_on:dependencies,parallel_with:parallel});
const analysis = (streams:any[], representation="role_plan") => ({intent:"executable_task",representation,reason:"Проверяемые результаты",question:null,workstreams:streams});
const roles = ["builder", "qa"];
describe("единая подготовка задач", () => {
  it("не превращает вопрос в карточку", () => expect(() => validatePreparation({intent:"informational_question",question:"Почему?"},roles)).toThrow(NonTaskInputError));
  it("сохраняет последовательные результаты", () => expect(validatePreparation(analysis([stream("build","builder"),stream("verify","qa",["build"])]),roles).workstreams[1].depends_on).toEqual(["build"]));
  it("допускает дочерние карточки при неизвестной совместимости, блокируя запуск", () => {
    const result=validatePreparation(analysis([stream("one","builder"),stream("two","qa")],"child_cards"),roles);
    expect(result.representation).toBe("child_cards"); expect(result.question).toBeTruthy();
  });
  it("пропускает взаимно подтверждённую совместимость", () => expect(validatePreparation(analysis([stream("one","builder",[],["two"]),stream("two","qa",[],["one"])]),roles).question).toBeNull());
  it("отклоняет неизвестную роль", () => expect(() => validatePreparation(analysis([stream("one","ghost")]),roles)).toThrow(/роль/));
  it("отклоняет цикл и неизвестные ссылки", () => {
    expect(() => validatePreparation(analysis([stream("one","builder",["two"]),stream("two","qa",["one"])]),roles)).toThrow(/цикл/);
    expect(() => validatePreparation(analysis([stream("one","builder",["missing"])]),roles)).toThrow(/ссылк/);
  });
  it("учитывает транзитивную зависимость", () => expect(validatePreparation(analysis([stream("one","builder"),stream("two","qa",["one"]),stream("three","builder",["two"])]),roles).question).toBeNull());
  it("отклоняет совместимость зависимых потоков", () => expect(() => validatePreparation(analysis([stream("one","builder",[],["two"]),stream("two","qa",["one"],["one"])]),roles)).toThrow(/зависим/i));
  it("требует контракт и ограничивает число результатов", () => {
    expect(() => validatePreparation(undefined,roles)).toThrow();
    expect(() => validatePreparation(analysis(Array.from({length:13},(_,i)=>stream(`w${i}`,"builder"))),roles)).toThrow(/12/);
  });
});
