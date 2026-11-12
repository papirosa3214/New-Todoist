import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Type } from "typebox";
import { connectInfraPanel } from "./infraPanelMcp.js";
import { connectWealthfolio } from "./wealthfolioMcp.js";
import { connectChangedetection } from "./changedetectionMcp.js";
import { connectRea } from "./reaMcp.js";

// Граф кода для ролей (владелец 20.10.2026): роли искали код вслепую по
// дискам — десятки шагов на ответ. Теперь у каждой роли инструменты `graft_*`
// поверх `graft mcp` — тот же граф, что у агентов на .110. Один процесс графа
// обслуживает один репозиторий, поэтому к каждому инструменту добавлен
// аргумент `repo`: по умолчанию — проект, в папке которого идёт работа,
// иначе TaskFlow. Процесс поднимается при первом обращении к проекту.

const PROJECTS_DIR = path.join(os.homedir(), "Проекты");
const GRAFT_BIN = path.join(os.homedir(), ".local", "bin", "graft");
const FALLBACK_REPO = "New-Todoist";
const empty = () => ({ tools: [] as any[], close: async () => {} });

/** Проекты на .110, у которых есть граф (`graft/` в корне). */
function graftRepos(): string[] {
  try {
    return fs
      .readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(
        (d) =>
          d.isDirectory() &&
          fs.existsSync(path.join(PROJECTS_DIR, d.name, "graft")),
      )
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

/** Ближайший предок `cwd` с папкой `graft/` — рабочая копия карточки тоже подходит. */
function repoRootFor(cwd: string | undefined): string | null {
  let dir = cwd ? path.resolve(cwd) : "";
  while (dir && dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "graft"))) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

/** Граф дописывает в ответ служебные строки `[graft] …`, в том числе просьбу
 *  сообщить пользователю сэкономленные токены. Роли это не нужно, а владельцу
 *  тем более — вырезаем. */
function stripGraftChatter(content: any): any {
  if (!Array.isArray(content)) return content;
  return content.map((part) =>
    part?.type === "text" && typeof part.text === "string"
      ? {
          ...part,
          text: part.text
            .split("\n")
            .filter((l: string) => !l.startsWith("[graft]"))
            .join("\n")
            .trimStart(),
        }
      : part,
  );
}

async function openClient(root: string): Promise<Client> {
  const client = new Client({ name: "taskflow-role-graft", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: GRAFT_BIN,
    args: ["mcp", root],
    stderr: "ignore",
    // Без автообновления графа (владелец 24.10.2026): граф построен заранее,
    // а refresh на каждый запрос пересобирал его и молотил CPU. Graft сам
    // читает GRAFT_NO_REFRESH и отвечает из графа как есть.
    env: { GRAFT_NO_REFRESH: "1" },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.connect(transport),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Граф кода: время подключения истекло")),
          15_000,
        );
      }),
    ]);
    return client;
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function connectGraft(cwd?: string) {
  if (!fs.existsSync(GRAFT_BIN)) return empty();
  const repos = graftRepos();
  const own = repoRootFor(cwd);
  const defaultRoot =
    own ??
    (repos.includes(FALLBACK_REPO)
      ? path.join(PROJECTS_DIR, FALLBACK_REPO)
      : null);
  if (!defaultRoot) return empty();
  const defaultName = own ? path.basename(own) : FALLBACK_REPO;

  const clients = new Map<string, Promise<Client>>();
  const clientFor = (root: string) => {
    let pending = clients.get(root);
    if (!pending) {
      pending = openClient(root);
      pending.catch(() => clients.delete(root));
      clients.set(root, pending);
    }
    return pending;
  };

  const listed = await (await clientFor(defaultRoot)).listTools();
  const repoNames = Array.from(new Set([defaultName, ...repos]));
  const tools: any[] = listed.tools.map((t) => {
    const schema: any = JSON.parse(
      JSON.stringify(t.inputSchema ?? { type: "object", properties: {} }),
    );
    schema.properties = {
      ...(schema.properties ?? {}),
      repo: {
        type: "string",
        enum: repoNames,
        description: `Проект, по графу которого искать. По умолчанию ${defaultName}.`,
      },
    };
    return {
      name: t.name,
      label: "Граф кода · " + t.name,
      description:
        (t.description ?? t.name) +
        ` Проекты с графом: ${repoNames.join(", ")}.`,
      parameters: Type.Unsafe<Record<string, unknown>>(schema),
      execute: async (
        _id: string,
        args: Record<string, unknown>,
        signal?: AbortSignal,
      ) => {
        const { repo, ...rest } = args ?? {};
        const root =
          typeof repo === "string" &&
          repo &&
          repo !== defaultName &&
          repos.includes(repo)
            ? path.join(PROJECTS_DIR, repo)
            : defaultRoot;
        const client = await clientFor(root);
        const result = await client.callTool(
          { name: t.name, arguments: rest },
          undefined,
          { signal, timeout: 120_000 },
        );
        if (result.isError) throw new Error(JSON.stringify(result.content));
        return {
          content: stripGraftChatter(result.content),
          details: { source: "graft", tool: t.name, repo: path.basename(root) },
        };
      },
    };
  });

  return {
    tools,
    close: async () => {
      await Promise.all(
        [...clients.values()].map((p) =>
          p.then((c) => c.close()).catch(() => {}),
        ),
      );
    },
  };
}

/** Внешние MCP роли одним вызовом: Пульт .110 (только инженер), граф кода
 *  (все роли) и финансовый трекер (только помощник владельца). Сбой одного не
 *  лишает роль другого. Разбор бинарников REA (исследователь, инженер) —
 *  владелец 12.11.2026: без него роли зовут CLI вручную на каждый вызов. */
export async function connectRoleMcp(role: string, cwd?: string) {
  const [infra, graft, finance, pages, rea] = await Promise.all([
    connectInfraPanel(role).catch((error) => {
      console.warn(`[infra-panel] ${role}: ${error instanceof Error ? error.message : error}`);
      return empty();
    }),
    connectGraft(cwd).catch((error) => {
      console.warn(`[graft] ${role}: ${error instanceof Error ? error.message : error}`);
      return empty();
    }),
    connectWealthfolio(role).catch((error) => {
      console.warn(`[wealthfolio] ${role}: ${error instanceof Error ? error.message : error}`);
      return empty();
    }),
    connectChangedetection(role).catch((error) => {
      console.warn(`[changedetection] ${role}: ${error instanceof Error ? error.message : error}`);
      return empty();
    }),
    connectRea(role).catch((error) => {
      console.warn(`[rea] ${role}: ${error instanceof Error ? error.message : error}`);
      return empty();
    }),
  ]);
  return {
    tools: [...infra.tools, ...graft.tools, ...finance.tools, ...pages.tools, ...rea.tools],
    close: async () => {
      await Promise.all([
        infra.close().catch(() => {}),
        graft.close().catch(() => {}),
        finance.close().catch(() => {}),
        pages.close().catch(() => {}),
        rea.close().catch(() => {}),
      ]);
    },
  };
}
