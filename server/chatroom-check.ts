import { ensurePersonalRoom } from "./src/lib/chatRooms.js";
console.log("personal qa:", ensurePersonalRoom("role_qa"));
console.log("personal researcher:", ensurePersonalRoom("role_researcher"));
