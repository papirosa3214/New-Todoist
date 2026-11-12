// Сценарии JEV для памяти и навыков ролей (владелец 16.10.2026, по образцу
// раздела Ekko, но без лишнего — разбор в docs/jev-integration-points.md).
// Общее правило всех трёх: выключено, нет ключа, не ответил, не уверен —
// прежнее поведение. JEV только убирает лишнее, ничего не добавляет сам.
import { skippedObservation, updateObservation } from "./contextObservability.js";
import { jevSkipReason, evaluateJev, jevScenario, type JevQuestion } from "./jev.js";
import { getEmbeddings } from "./embeddingClient.js";

/** Память подбирается на каждом ходу роли — дольше ждать нельзя. */
const MEMORY_TIMEOUT_MS = 3000;
/** Сколько найденных записей отдаём JEV на оценку. */
export const MEMORY_CANDIDATES = 15;
/** Меньше навыков — выбирать не из чего, JEV не зовём. */
export const SKILLS_MIN_TO_SELECT = 7;


const YOUTUBE_SKILL = "youtube-research";
const YOUTUBE_REQUEST = /(?:youtu\.be|(?:www\.)?youtube\.com|youtube\s+(?:видео|ролик)|(?:видео|ролик)\s+(?:с|из)\s*youtube)/i;
const BGE_YOUTUBE_MIN_SIMILARITY = 0.42;

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length !== right.length || left.length === 0) return -1;
  let dot = 0; let leftNorm = 0; let rightNorm = 0;
  for (let i = 0; i < left.length; i++) {
    dot += left[i] * right[i]; leftNorm += left[i] * left[i]; rightNorm += right[i] * right[i];
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : -1;
}

/** Local semantic reserve for the one explicit YouTube skill.  It only runs
 * after an observable YouTube trigger, so BGE cannot silently narrow unrelated
 * skill packs when JEV is unavailable. */
async function selectYoutubeSkillByBge(
  work: { title: string; description: string | null; step?: string | null },
  skills: Array<{ name: string; description: string }>,
  requiredNames: readonly string[],
): Promise<Set<string> | null> {
  const youtube = skills.find((skill) => skill.name === YOUTUBE_SKILL);
  const state = [work.title, work.description, work.step].filter(Boolean).join("\n");
  if (!youtube || !YOUTUBE_REQUEST.test(state)) return null;
  try {
    const out = await getEmbeddings(
      ["Запрос о видео YouTube:\n" + state, youtube.description],
      { purpose: "skill_youtube_fallback", maxBatch: 2 },
    );
    const vectors = out.embeddings;
    if (!Array.isArray(vectors) || !Array.isArray(vectors[0]) || !Array.isArray(vectors[1])) return null;
    if (cosineSimilarity(vectors[0] as number[], vectors[1] as number[]) < BGE_YOUTUBE_MIN_SIMILARITY) return null;
    return new Set([...requiredNames, YOUTUBE_SKILL]);
  } catch {
    // BGE is a reserve, never a new reason to deprive the role of all skills.
    return null;
  }
}


async function rankByBge(query: string, candidates: string[], purpose: string): Promise<number[] | null> {
  if (!query.trim() || !candidates.length) return null;
  try {
    const out = await getEmbeddings([query, ...candidates], { purpose, maxBatch: candidates.length + 1 });
    const vectors = out.embeddings;
    if (!Array.isArray(vectors) || !Array.isArray(vectors[0])) return null;
    const queryVector = vectors[0] as number[];
    const scores = (vectors as number[][]).slice(1).map((vector) => cosineSimilarity(queryVector, vector));
    return scores.every(Number.isFinite) ? scores : null;
  } catch { return null; }
}

async function selectSkillsByBge(
  work: { title: string; description: string | null; step?: string | null },
  skills: Array<{ name: string; description: string }>, requiredNames: readonly string[],
): Promise<Set<string> | null> {
  const query = [work.title, work.description, work.step].filter(Boolean).join("\n");
  const scores = await rankByBge(query, skills.map((skill) => skill.name + ": " + skill.description), "skill_selection_bge");
  if (!scores) return null;
  const keep = new Set(requiredNames);
  scores.forEach((score, index) => { if (score >= 0.42) keep.add(skills[index].name); });
  return keep.size ? keep : null;
}

async function filterMemoryByBge<T extends { text: string; title: string | null; pinned: boolean }>(query: string, items: T[]): Promise<T[] | null> {
  const candidates = items.filter((item) => !item.pinned).slice(0, MEMORY_CANDIDATES);
  const scores = await rankByBge(query, candidates.map((item) => (item.title ? item.title + "\n" : "") + item.text), "memory_recall_bge");
  if (!scores || Math.max(...scores) < 0.42) return null;
  const ranked = candidates.map((item, index) => ({ item, score: scores[index] })).sort((a,b) => b.score - a.score).map((entry) => entry.item);
  const pinned = items.filter((item) => item.pinned);
  const rest = items.filter((item) => !item.pinned && !candidates.includes(item));
  return [...pinned, ...ranked, ...rest];
}

/**
 * Отбор памяти для роли. На вход — найденные по сходству записи (уже
 * отсортированные), на выход — тот же список без уверенно ненужных и в
 * порядке полезности. Закреплённые записи не оцениваются и не выкидываются.
 * null — JEV не применялся, брать исходный список.
 */
export async function filterMemoryByJev<
  T extends { text: string; title: string | null; pinned: boolean },
>(query: string, items: T[]): Promise<T[] | null> {
  if (!query.trim()) {skippedObservation("memoryRecall","empty_query");return null;}
  const byBge = await filterMemoryByBge(query, items);
  if (byBge) return byBge;
  const cfg = jevScenario("memoryRecall");
  if (!cfg) {skippedObservation("memoryRecall",jevSkipReason("memoryRecall"));return null;}
  const candidates = items.filter((i) => !i.pinned).slice(0, MEMORY_CANDIDATES);
  if (candidates.length === 0) {skippedObservation("memoryRecall","no_candidates");return null;}

  const questions: Record<string, JevQuestion> = {};
  candidates.forEach((c, i) => {
    questions[`m${i}`] = {
      type: "noul",
      instructions: {
        memory: c.title ? `${c.title}\n${c.text}` : c.text,
        question: "Пригодится ли запись `memory` для текущей работы из state?",
      },
    };
  });
  const result = await evaluateJev({ work: query.slice(0, 6000) }, questions, {
    timeoutMs: MEMORY_TIMEOUT_MS, scenario:"memoryRecall",
  });
  if (!result) return null;

  const useful = new Map<T, number>();
  let answered = 0;
  candidates.forEach((c, i) => {
    const a = result.answers[`m${i}`];
    if (!a || a.type !== "noul" || typeof a.noul !== "number") {
      useful.set(c, 0.5); // нет ответа — не выкидываем
      return;
    }
    answered++;
    // Выкидываем только УВЕРЕННО ненужное: «да» с вероятностью ниже 1-порога.
    if (a.noul >= 1 - cfg.minConfidence) useful.set(c, a.noul);
  });
  if (answered === 0) {updateObservation(result.observationId,{reason:"no_valid_answers",inputCount:candidates.length,outputCount:candidates.length});return null;}

  const pinned = items.filter((i) => i.pinned);
  const rest = items.filter((i) => !i.pinned && !candidates.includes(i));
  const kept = candidates
    .filter((c) => useful.has(c))
    .sort((a, b) => useful.get(b)! - useful.get(a)!);
  updateObservation(result.observationId,{reason:"applied",inputCount:candidates.length,outputCount:kept.length,details:kept.map(c=>c.title??"Запись памяти")});
  return [...pinned, ...kept, ...rest];
}

export class MemoryWriteRejected extends Error {}

/**
 * Проверка записи в память — только для записей ролей. Бросает
 * MemoryWriteRejected, если JEV УВЕРЕННО считает запись разовой деталью, а не
 * знанием на будущее. В остальных случаях молчит, и запись идёт как обычно.
 */
export async function reviewMemoryWriteByJev(input: {
  kind: string;
  title: string | null;
  text: string;
}): Promise<void> {
  const cfg = jevScenario("memoryWrite");
  if (!cfg) {skippedObservation("memoryWrite",jevSkipReason("memoryWrite"));return;}
  const result = await evaluateJev(
    { kind: input.kind, title: input.title, text: input.text },
    {
      durable: {
        type: "noul",
        instructions:
          "Это устойчивое знание, которое пригодится команде в будущих задачах (факт, урок, предпочтение владельца), а не разовая деталь текущей работы, черновик или пересказ сделанного?",
      },
    },
    { timeoutMs: MEMORY_TIMEOUT_MS, scenario:"memoryWrite" },
  );
  const a = result?.answers?.durable;
  if (!a || a.type !== "noul" || typeof a.noul !== "number") {updateObservation(result?.observationId??null,{reason:"no_valid_answers"});return;}
  updateObservation(result?.observationId??null,{reason:a.noul<=1-cfg.minConfidence?"rejected":"allowed",inputCount:1,outputCount:a.noul<=1-cfg.minConfidence?0:1,details:["Оценка устойчивости: "+a.noul]});
  if (a.noul <= 1 - cfg.minConfidence) {
    throw new MemoryWriteRejected(
      "запись не сохранена: похоже на разовую деталь текущей работы, а не на знание на будущее. Сформулируй как правило, факт или урок, который пригодится в других задачах.",
    );
  }
}

/**
 * Навыки под задачу. На вход — навыки роли и описание работы; на выход —
 * имена навыков, которые стоит дать роли, или null (давать все).
 */
export async function selectSkillsByJev(
  work: { title: string; description: string | null; step?: string | null },
  skills: Array<{ name: string; description: string }>,
  requiredNames: readonly string[] = [],
): Promise<Set<string> | null> {
  if (skills.length && skills.every(s => requiredNames.includes(s.name))) {
    skippedObservation("skills","required_skills");return null;
  }
  const byBge = await selectSkillsByBge(work, skills, requiredNames);
  if (byBge) return byBge;
  const cfg = jevScenario("skills");
  if (!cfg) {
    skippedObservation("skills", jevSkipReason("skills"));
    return selectYoutubeSkillByBge(work, skills, requiredNames);
  }
  if (skills.length < SKILLS_MIN_TO_SELECT) {skippedObservation("skills","too_few_skills");return null;}
  const questions: Record<string, JevQuestion> = {};
  skills.forEach((s, i) => {
    questions[`s${i}`] = {
      type: "noul",
      instructions: {
        skill: `${s.name}: ${s.description}`,
        question: "Понадобится ли навык `skill` для работы из state?",
      },
    };
  });
  const result = await evaluateJev(
    {
      card: work.title,
      description: (work.description ?? "").slice(0, 6000),
      current_step: work.step ?? null,
    },
    questions,
    {scenario:"skills"},
  );
  if (!result) return selectYoutubeSkillByBge(work, skills, requiredNames);
  const keep = new Set(skills.filter(s => requiredNames.includes(s.name)).map(s => s.name));
  skills.forEach((s, i) => {
    const a = result.answers[`s${i}`];
    // Нет ответа по навыку — оставляем: лишний навык дешевле отрезанного нужного.
    if (!a || a.type !== "noul" || typeof a.noul !== "number" || a.noul >= 0.5)
      keep.add(s.name);
  });
  updateObservation(result.observationId,{reason:keep.size?"applied":"empty_selection_fallback",inputCount:skills.length,outputCount:keep.size||skills.length,details:(keep.size?skills.filter(s=>keep.has(s.name)):skills).map(s=>s.name)});
  return keep.size ? keep : null;
}
