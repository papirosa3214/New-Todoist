// @ts-nocheck — копия внешнего расширения Pi, грузится самим Pi (jiti); типы SDK у исходника расходятся.
// ═══ КОПИЯ ДЛЯ СЕССИЙ ВЛАДЕЛЬЦА (13.11.2026). Исходник — ~/.pi/agent/extensions/verify-before-claim.ts.
// Отличие (владелец 13.11.2026): непроверенное утверждение НЕ заменяется
// предупреждением для владельца — агент сам получает указание «проверь» и
// дорабатывает; владелец видит уже проверенный ответ. Не больше
// MAX_NUDGES_PER_RUN напоминаний на одно сообщение владельца — не зациклиться.
/**
 * verify-before-claim extension (fixed)
 *
 * Два уровня защиты:
 *
 * 1. Кастомный tool `verify_claim` — LLM обязан вызвать его перед утверждением.
 *    Tool сверяет утверждение с недавними verify-tool результатами (input + output).
 *
 * 2. Pre-send block на `message_end` — если сообщение похоже на утверждение
 *    и нет verified=true для него (или близкого текста), сообщение заменяется
 *    на предупреждение.
 *
 * Исправления относительно исходной версии:
 * - evidence пишется из `tool_result` (input+output), а не из `tool_call`
 * - `verify_claim` не попадает в evidence-историю (раньше он становился
 *   «последним tool_call» и ломал проверку — verified почти всегда false)
 * - ключ сверки = нормализованный текст claim, не только entities
 *   (entities-only fingerprint давал коллизии и миссматчи с финальным текстом)
 * - ищем совпадение claim↔сообщение гибко (exact / substring / token overlap)
 * - учитываем встроенные grep/find/ls, а не только bash+read
 * - claim-детектор смотрит по строкам, не только начало всего сообщения
 * - стейт чистится на session_start
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ─── Конфиг ────────────────────────────────────────────────────────────────

const MAX_NUDGES_PER_RUN = 2;
let nudgesThisRun = 0;
const HISTORY_LIMIT = 40;
const VERIFY_TOOL_NAME = "verify_claim";

const CLAIM_BLOCK_REASON =
    "Сначала вызови tool `verify_claim` с текстом утверждения — он проверит, " +
    "доказывает ли недавний verify-tool (grep/ps/getMe/read/…) это утверждение. " +
    "Если verify_claim вернёт verified=false — перепроверь факт другим tool и вызови verify_claim снова.";

/** Утверждения: матчим по строкам сообщения. */
const CLAIM_LINE_PATTERNS: RegExp[] = [
    /^(нашёл|нашла|найдено)\b/i,
    /^(это|вот это|этот|эта)\s+(тот|самый|код|бот|скрипт|файл|процесс|юнит)/i,
    /^(бот\s+|tg[-\s]?|пи[-\s]?бот|релей|relay)\s*[=:]/i,
    /^(да|нет)\s*[,.]?\s*(это|там|тут)/i,
    /^факт:/i,
    /^(докладываю|подтверждаю|фиксирую|зафиксировано)\b/i,
    /^(X|Y|Z)\s*=\s*(да|нет|true|false|работает|не работает|запущен|жив|убит|спит)/i,
];

const CLAIM_ANYWHERE_PATTERNS: RegExp[] = [
    /\b(связано с|соответствует|относится к|это тот самый|это и есть)\b/i,
    /\b(работает|запущен|жив|убит|доступен|недоступен)\s*[.!]?\s*$/i,
];

/** bash-команды, которые считаем verify-tool. */
const VERIFY_BASH_REGEXES: RegExp[] = [
    /\bgetMe\b/,
    /\bgetUpdates\b/,
    /\bgetMyCommands\b/,
    /\bgetChatMenuButton\b/,
    /\bgetWebhookInfo\b/,
    /(^|\s)(grep|rg|find|fd)\s/,
    /(^|\s)(ps|systemctl|ss|netstat|lsof)\s/,
    /(^|\s)(stat|file|test|wc|md5sum|sha256sum)\s/,
    /(^|\s)(ls|dir)\s+(-[a-zA-Z]*[la]+|-R|\S+)/,
    /(^|\s)(cat|head|tail|less|more)\s+\S+/,
    /\bssh\b.*\b(getMe|hostname|uname|ls|cat|id|whoami|ps|rg|grep)\b/,
    /\bcurl\b.*\b(getMe|api\.telegram\.org)\b/,
];

/** Встроенные tools pi, которые сами по себе verify. */
const VERIFY_BUILTIN_TOOLS = new Set([
    "read",
    "grep",
    "find",
    "ls",
]);

const ENTITY_PATTERNS: RegExp[] = [
    /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
    /@[A-Za-z0-9_]+/g,
    /~\/[^\s,;:'"()\[\]{}]+/g,
    /\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+/g,
    /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g,
    /\b[A-Za-z][A-Za-z0-9_-]{3,}\.(py|ts|js|sh|md|yaml|yml|json|toml)\b/g,
    /\b\d{6,12}\b/g,
    // более строгие идентификаторы: не матчим короткие служебные слова
    /\b(?!(?:true|false|null|undefined|string|number|object|array|error|output|input|claim|verified|reason)\b)[A-Za-z][A-Za-z0-9_-]{4,}\b/g,
];

const STOP_WORDS = new Set([
    "этот", "эта", "это", "того", "том", "там", "тут", "есть", "было", "будет",
    "нашёл", "нашла", "найдено", "докладываю", "подтверждаю", "фиксирую",
    "работает", "запущен", "доступен", "недоступен", "связан", "связано",
    "соответствует", "относится", "самый", "который", "которая", "которые",
]);

// ─── Types / state ─────────────────────────────────────────────────────────

type Evidence = {
    toolName: string;
    input: unknown;
    output: string;
    isError: boolean;
};

type Verification = {
    claimNorm: string;
    verified: boolean;
    reason: string;
    evidence_tool: string;
    evidence_input: string;
};

const evidenceHistory: Evidence[] = [];
/** Нормализованный claim → результат verify_claim */
const verifiedClaims = new Map<string, Verification>();
/** Порядок недавних verify_claim (для гибкого матча на message_end) */
const recentClaimNorms: string[] = [];

// ─── Утилиты ───────────────────────────────────────────────────────────────

function extractTextFromContent(
    content?: Array<{ type: string; text?: string }> | null,
): string {
    if (!content) return "";
    return content
        .filter((c) => c?.type === "text" && typeof c.text === "string")
        .map((c) => (c as { text: string }).text)
        .join("\n");
}

function normalizeClaim(text: string): string {
    return text
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ")
        .slice(0, 500);
}

function isClaim(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed) return false;
    if (CLAIM_ANYWHERE_PATTERNS.some((rx) => rx.test(trimmed))) return true;
    const lines = trimmed.split(/\n+/).map((l) => l.trim()).filter(Boolean);
    return lines.some((line) => CLAIM_LINE_PATTERNS.some((rx) => rx.test(line)));
}

function extractEntities(text: string): Set<string> {
    const out = new Set<string>();
    for (const rx of ENTITY_PATTERNS) {
        // reset lastIndex for global regexes reused across calls
        rx.lastIndex = 0;
        for (const m of text.matchAll(rx)) {
            const s = (m[0] || "").toLowerCase().replace(/[/._-]+$/, "");
            if (s.length >= 3 && !STOP_WORDS.has(s)) out.add(s);
        }
    }
    return out;
}

function significantTokens(text: string): string[] {
    return text
        .toLowerCase()
        .split(/[^a-zа-яё0-9_./:@-]+/i)
        .map((w) => w.replace(/^[^a-zа-яё0-9@]+|[^a-zа-яё0-9]+$/gi, ""))
        .filter((w) => w.length >= 4 && !STOP_WORDS.has(w));
}

function tokenOverlap(a: string, b: string): number {
    const sa = new Set(significantTokens(a));
    const sb = new Set(significantTokens(b));
    if (sa.size === 0 || sb.size === 0) return 0;
    let n = 0;
    for (const t of sa) if (sb.has(t)) n++;
    return n;
}

function callToEvidenceString(input: unknown): string {
    if (typeof input === "object" && input !== null) {
        try {
            return JSON.stringify(input).slice(0, 4000);
        } catch {
            return String(input);
        }
    }
    return String(input ?? "");
}

function isVerifyEvidence(e: Evidence): boolean {
    if (e.isError) return false;
    if (VERIFY_BUILTIN_TOOLS.has(e.toolName)) return true;
    if (e.toolName === "bash" || e.toolName === "powershell") {
        const cmd = String(
            (e.input as { command?: string })?.command ?? "",
        );
        if (!cmd) return false;
        return VERIFY_BASH_REGEXES.some((rx) => rx.test(cmd));
    }
    return false;
}

function findLastVerifyEvidence(): Evidence | undefined {
    for (let i = evidenceHistory.length - 1; i >= 0; i--) {
        const e = evidenceHistory[i];
        if (isVerifyEvidence(e)) return e;
    }
    return undefined;
}

function rememberVerification(v: Verification): void {
    verifiedClaims.set(v.claimNorm, v);
    recentClaimNorms.push(v.claimNorm);
    if (recentClaimNorms.length > 50) recentClaimNorms.shift();
    // не разрастаем map бесконечно
    if (verifiedClaims.size > 80) {
        const oldest = recentClaimNorms.shift();
        if (oldest) verifiedClaims.delete(oldest);
    }
}

/**
 * Найти verification для исходящего сообщения.
 * Exact → substring → token overlap (нужно ≥2 значимых токена).
 */
function findVerificationForMessage(messageText: string): Verification | undefined {
    const norm = normalizeClaim(messageText);
    if (!norm) return undefined;

    const direct = verifiedClaims.get(norm);
    if (direct) return direct;

    let best: { v: Verification; score: number } | undefined;

    for (const key of recentClaimNorms) {
        const v = verifiedClaims.get(key);
        if (!v) continue;

        let score = 0;
        if (norm === key) score = 100;
        else if (norm.includes(key) || key.includes(norm)) score = 80;
        else {
            const overlap = tokenOverlap(norm, key);
            if (overlap >= 2) score = 40 + overlap;
        }

        if (score > 0 && (!best || score > best.score)) {
            best = { v, score };
        }
    }

    return best?.v;
}

function resetState(): void {
    evidenceHistory.length = 0;
    verifiedClaims.clear();
    recentClaimNorms.length = 0;
}

// ─── Extension ─────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
    // Счётчик — на одно сообщение ВЛАДЕЛЬЦА, а не на ход: напоминание само
    // запускает новый ход, и обнуление на agent_start давало бесконечный круг
    // (владелец 13.11.2026: «против зацикливания»). Служебные сообщения —
    // role "custom", они счётчик не сбрасывают.
    pi.on("message_start", (event) => {
        if ((event as any).message?.role === "user") nudgesThisRun = 0;
    });
    pi.on("session_start", () => {
        resetState();
    });

    // Evidence из РЕЗУЛЬТАТА tool (input + output). verify_claim пропускаем.
    pi.on("tool_result", (event) => {
        if (event.toolName === VERIFY_TOOL_NAME) return;

        const output = extractTextFromContent(
            event.content as Array<{ type: string; text?: string }>,
        );

        evidenceHistory.push({
            toolName: event.toolName,
            input: event.input,
            output: output.slice(0, 8000),
            isError: Boolean(event.isError),
        });
        if (evidenceHistory.length > HISTORY_LIMIT) evidenceHistory.shift();
    });

    pi.registerTool({
        name: VERIFY_TOOL_NAME,
        label: "Verify Claim",
        description:
            "ОБЯЗАТЕЛЬНО вызови этот tool ПЕРЕД тем, как сообщить Максиму любое утверждение " +
            "(«нашёл», «это X», «X = Y», «работает», «связано с», «докладываю», и т.п.). " +
            "Передай свой текст утверждения в параметр claim. Tool проверит, что недавний " +
            "verify-tool (getMe / grep / find / ps / stat / read / ls и т.п.) реально доказывает " +
            "это утверждение по пересечению сущностей с input+output, и вернёт verified=true/false. " +
            "Если verified=false — перепроверь факт другим verify-tool и вызови verify_claim снова. " +
            "Если утверждения нет (просто «ок», вопрос, команда) — НЕ вызывай этот tool.",
        promptSnippet: "Verify a factual claim against recent tool evidence before telling the user",
        promptGuidelines: [
            "Before stating a factual claim to the user (found X, this is Y, status=Z, linked to…), call verify_claim with the exact claim text.",
            "If verify_claim returns verified=false, gather better evidence with read/grep/bash/… and call verify_claim again before claiming.",
            "Do not call verify_claim for pure questions, acknowledgements, or commands with no factual claim.",
        ],
        parameters: Type.Object({
            claim: Type.String({
                description: "Текст утверждения, которое собираешься сообщить Максиму",
            }),
        }),
        async execute(_toolCallId, params) {
            const claim = String(params.claim ?? "").trim();
            const claimNorm = normalizeClaim(claim);

            const last = findLastVerifyEvidence();
            if (!last) {
                const result = {
                    verified: false as const,
                    reason:
                        "Нет недавнего verify-tool результата (read/grep/find/ls/bash-verify). " +
                        "Сначала собери evidence, потом вызови verify_claim.",
                };
                rememberVerification({
                    claimNorm,
                    verified: false,
                    reason: result.reason,
                    evidence_tool: "—",
                    evidence_input: "—",
                });
                return {
                    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                    details: result,
                };
            }

            const evidenceInput = callToEvidenceString(last.input);
            // Сверяем и с аргументами, и с выводом — иначе «доказательство» было только по команде.
            const evidenceText = `${evidenceInput}\n${last.output}`;

            const claimEntities = extractEntities(claim);
            const evidenceEntities = extractEntities(evidenceText);

            const common: string[] = [];
            for (const e of claimEntities) {
                if (evidenceEntities.has(e)) common.push(e);
            }

            const keywordFallback: string[] = [];
            for (const w of significantTokens(claim)) {
                if (evidenceText.toLowerCase().includes(w)) keywordFallback.push(w);
            }

            // Требуем пересечение с OUTPUT, если output не пустой — иначе легко
            // «подтвердить» claim одной только командой без данных.
            let outputSupports = true;
            if (last.output.trim().length > 0) {
                const outEntities = extractEntities(last.output);
                const commonOut: string[] = [];
                for (const e of claimEntities) {
                    if (outEntities.has(e)) commonOut.push(e);
                }
                const kwOut = significantTokens(claim).filter((w) =>
                    last.output.toLowerCase().includes(w),
                );
                outputSupports = commonOut.length > 0 || kwOut.length >= 1;
            }

            const ok =
                outputSupports && (common.length > 0 || keywordFallback.length >= 2);

            const result = {
                verified: ok,
                reason: ok
                    ? `OK: общие сущности [${[...new Set([...common, ...keywordFallback])]
                          .slice(0, 5)
                          .join(", ")}] есть в утверждении и в evidence (${last.toolName}).`
                    : !outputSupports
                      ? `Сущности из утверждения не находятся в OUTPUT tool (${last.toolName}). ` +
                        `Команда/input сами по себе ничего не доказывают. Перепроверь.`
                      : `Не нашёл общих сущностей между утверждением и evidence (${last.toolName}). ` +
                        `Скорее всего этот tool доказывает другое. Перепроверь.`,
                evidence_tool: last.toolName,
                evidence_input_preview: evidenceInput.slice(0, 200),
                evidence_output_preview: last.output.slice(0, 200),
            };

            rememberVerification({
                claimNorm,
                verified: ok,
                reason: result.reason,
                evidence_tool: last.toolName,
                evidence_input: evidenceInput.slice(0, 4000),
            });

            return {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                details: result,
            };
        },
    });

    // Pre-send block
    pi.on("message_end", async (event, ctx) => {
        if (event.message.role !== "assistant") return;

        const original = extractTextFromContent(
            (event.message as { content?: Array<{ type: string; text?: string }> })
                .content,
        );
        if (!isClaim(original)) return;

        const v = findVerificationForMessage(original);

        if (v && v.verified) {
            verifiedClaims.delete(v.claimNorm);
            return;
        }

        if (nudgesThisRun >= MAX_NUDGES_PER_RUN) return;
        nudgesThisRun += 1;

        const last = findLastVerifyEvidence();
        const lastAny = evidenceHistory[evidenceHistory.length - 1];
        const shown = last ?? lastAny;
        const lastDesc = shown
            ? `${shown.toolName}(${callToEvidenceString(shown.input).slice(0, 80)})`
            : "—";
        const reasonText = v
            ? `verify_claim вернул verified=false: ${v.reason}`
            : `verify_claim не вызывался для этого утверждения. ${CLAIM_BLOCK_REASON}`;

        // Ответ владельцу не трогаем — агенту служебное указание, он
        // проверяет и продолжает ход.
        await pi.sendMessage({
            customType: "verify-before-claim",
            display: false,
            content:
                `Ты утверждаешь, не проверив: "${original.trim().slice(0, 200)}". ` +
                `${reasonText} Последнее действие-доказательство: ${lastDesc}. ` +
                `Проверь это (прочитай/запусти) и вызови verify_claim, затем дай владельцу проверенный ответ. ` +
                `Если проверить нельзя — так и скажи владельцу, без утверждения.`,
        }, { triggerTurn: true, deliverAs: "followUp" });
    });
}
