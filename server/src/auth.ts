import type { FastifyRequest, FastifyReply } from "fastify";

export async function authMiddleware(req: FastifyRequest, reply: FastifyReply) {
  try {
    const token = req.headers.authorization?.replace("Bearer ", "");
    if (!token) return reply.code(401).send({ error: "No token" });

    const decoded = (req.server as any).jwt.verify(token) as { id: string };
    (req as any).userId = decoded.id;
  } catch {
    reply.code(401).send({ error: "Invalid token" });
  }
}

export async function optionalAuth(req: FastifyRequest, _reply: FastifyReply) {
  try {
    const token = req.headers.authorization?.replace("Bearer ", "");
    if (token) {
      const decoded = (req.server as any).jwt.verify(token) as { id: string };
      (req as any).userId = decoded.id;
    }
  } catch {
    // optional — continue without auth
  }
}
