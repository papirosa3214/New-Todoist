import db from "../db.js";
import {executeRoleHostTool} from "../runtime/roleHostAccess.js";
/**
 * Реестр машин по HTTP (тикет 1 «Сервер: реестр машин и шлюз хостов»).
 *
 * Кто заходит: только владелец. Реестр показывает, какие ключи выданы и какие
 * машины на связи — это то же, что список устройств в routes/devices.ts, и там
 * оно тоже своё.
 *
 * Ключ машины отдаётся ОДИН раз, в ответе на заведение. В базе его нет (только
 * sha256), достать его второй раз нельзя — можно только отозвать и выпустить
 * новый. Поэтому в списке наружу уходит префикс (`tfh_первые…`), по нему
 * человек узнаёт свою машину, и ничего секретного.
 *
 * Вызов операции по HTTP — проверочный инструмент («жива ли машина на самом
 * деле»), а не основной путь для ролей: роль зовет `runOperation` из
 * src/host/gateway.ts напрямую, потому что ей нужен поток и отмена по
 * AbortSignal, а по HTTP отмена не доезжает.
 */
import type { FastifyInstance } from "fastify";
import { authOrApiToken } from "../auth.js";
import { isOwner } from "../access.js";
import { isHostOperation } from "../host/protocol.js";
import { isMachineOnline, revokeHostMachine, runOperation } from "../host/gateway.js";
import {
  getMachine,
  issueMachineKey,
  listMachines,
  type Machine,
} from "../host/machines.js";

/** Поля, которые видит приложение. token_hash наружу не идёт никогда. */
function publicMachine(машина: Machine) {
  const жив = isMachineOnline(машина.id);
  return {
    id: машина.id,
    name: машина.name,
    platform: машина.platform,
    token_prefix: машина.token_prefix,
    allowed_roots: машина.allowed_roots,
    host_version: машина.host_version,
    created_at: машина.created_at,
    last_seen_at: машина.last_seen_at,
    // Онлайн берём из живых сокетов, а не из machines.online: база может
    // говорить «онлайн» после падения процесса сервера, и приложение показало
    // бы «на связи» машине, к которой подключиться не к кому.
    online: жив,
    revoked_at: машина.revoked_at,
    revoke_reason: машина.revoke_reason,
  };
}

export function registerHostRoutes(app: FastifyInstance): void {
  app.post("/api/role-host/execute",{preHandler:authOrApiToken},async(req:any,reply)=>{
    const user=db.prepare("SELECT role_key FROM users WHERE id=? AND type='ai'").get(req.userId) as {role_key:string}|undefined;
    if(!user?.role_key)return reply.code(403).send({error:"Операция доступна зарегистрированной роли"});
    try{return await executeRoleHostTool({role:user.role_key},req.body??{});}
    catch(error){return reply.code(409).send({error:(error as Error).message});}
  });
  app.get("/api/machines", { preHandler: authOrApiToken }, async (req: any, reply) => {
    if (!isOwner(req.userId)) {
      return reply.code(403).send({ error: "реестр машин доступен только владельцу" });
    }
    return listMachines().map(publicMachine);
  });

  // Заведение машины. Ключ — в ответе и больше нигде: если он потерялся,
  // машину отзывают и заводят заново.
  app.post<{
    Body: { name?: string; allowedRoots?: string[]; platform?: string };
  }>("/api/machines", { preHandler: authOrApiToken }, async (req: any, reply) => {
    if (!isOwner(req.userId)) {
      return reply.code(403).send({ error: "заводить машины может только владелец" });
    }
    const имя = (req.body?.name ?? "").trim();
    if (!имя) return reply.code(400).send({ error: "нужно имя машины" });

    // Корни обязательны: машина без разрешённых корней формально на связи, но
    // ни одной операции выполнить не может — лучше отказать здесь, чем потом
    // гадать, почему роль на маке ничего не смогла.
    const корни = (req.body?.allowedRoots ?? []).filter(
      (корень: unknown): корень is string =>
        typeof корень === "string" && корень.trim() !== "",
    );
    if (!корни.length) {
      return reply
        .code(400)
        .send({ error: "нужен хотя бы один разрешённый корень" });
    }

    try {
      const { machine, token } = issueMachineKey({
        name: имя,
        allowedRoots: корни,
        platform: req.body?.platform ?? null,
        createdBy: req.userId,
      });
      return { machine: publicMachine(machine), token };
    } catch (err) {
      // Имя живой машины уникально — об этом человеку нужно сказать словами,
      // а не кодом UNIQUE-индекса.
      if (String(err).includes("уже есть")) {
        return reply.code(409).send({ error: String(err instanceof Error ? err.message : err) });
      }
      throw err;
    }
  });

  /**
   * Отзыв ключа. Идемпотентен: повторный DELETE снова 200 с revoked:false —
   * «уже отозвано» это тот же результат, а не ошибка (вызывающий может
   * повторять запрос, разбираясь с ответом).
   *
   * Отзыв закрывает и живой сокет: иначе отозванная машина продолжила бы
   * получать операции, будучи «непринимаемой» только по документам.
   */
  app.delete<{ Params: { id: string }; Body: { reason?: string } }>(
    "/api/machines/:id",
    { preHandler: authOrApiToken },
    async (req: any, reply) => {
      if (!isOwner(req.userId)) {
        return reply.code(403).send({ error: "отзывать машины может только владелец" });
      }
      const машина = getMachine(req.params.id);
      if (!машина) return reply.code(404).send({ error: "машины нет" });

      const отозван = revokeHostMachine(машина.id, req.body?.reason ?? null);
      return {
        revoked: отозван,
        machine: publicMachine(getMachine(машина.id)!),
      };
    },
  );

  /**
   * Вызов операции на машине. Проверочный инструмент и задел для тикета 3:
   * роль зовёт `runOperation` из gateway.ts напрямую (там есть поток и отмена
   * по AbortSignal), сюда — когда нужно позвать с HTTP.
   *
   * Офлайн-машина — это 409, а не 500 и не ожидание: роль и человек должны
   * сразу видеть «мак не на связи» (план taskflow-host, D8).
   */
  app.post<{
    Params: { id: string };
    Body: { op?: string; args?: Record<string, unknown> };
  }>("/api/machines/:id/ops", { preHandler: authOrApiToken }, async (req: any, reply) => {
    if (!isOwner(req.userId)) {
      return reply.code(403).send({ error: "звать машины может только владелец" });
    }
    const машина = getMachine(req.params.id);
    if (!машина || машина.revoked_at) {
      return reply.code(404).send({ error: "машины нет" });
    }
    if (!isHostOperation(req.body?.op)) {
      return reply.code(400).send({ error: `операция «${req.body?.op}» хосту не положена` });
    }
    if (!isMachineOnline(машина.id)) {
      return reply.code(409).send({ error: `машина «${машина.name}» сейчас офлайн` });
    }
    try {
      // Вывод собираем здесь: хост отдаёт его кадрами op_chunk и в op_result
      // не дублирует, поэтому без onChunk вызывающий получил бы пустой stdout
      // и счётчики байт — команда выполнилась, а роль не видит ничего.
      let накоплено = "";
      const результат = await runOperation(машина.id, req.body!.op!, req.body?.args ?? {}, {
        onChunk: (часть) => {
          if (часть.stream === "stdout") накоплено += часть.data;
        },
      });
      if (результат.ok && !результат.stdout) {
        return { ...результат, stdout: накоплено };
      }
      return результат;
    } catch (err) {
      // Хост пропал посреди операции — это связь, а не поломка сервера.
      return reply.code(409).send({
        error: err instanceof Error ? err.message : "вызов не прошёл",
      });
    }
  });
}