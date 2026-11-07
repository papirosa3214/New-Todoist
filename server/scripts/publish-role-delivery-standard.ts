/** Publish the approved regulation to Library/Norms; source is versioned in docs/current.
 * Run from server/: node --import tsx scripts/publish-role-delivery-standard.ts
 * Explicit owner authorization required. Does not modify role AGENTS.md or task state.
 */
import fs from 'node:fs';
import path from 'node:path';
import db from '../src/db.js';
import { markdownToTiptap, deriveTitleFromMarkdown } from '../src/lib/markdownToTiptap.js';
import { tiptapToMarkdown } from '../src/lib/tiptapToMarkdown.js';
import { DELIVERY_STANDARD_NOTE_ID, ensureRoleHome } from '../src/runtime/roleHome.js';

const markdown = fs.readFileSync(path.resolve('../docs/current/role-delivery-standard.md'), 'utf8');
const title = deriveTitleFromMarkdown(markdown);
const folder = db.prepare("SELECT id FROM journal_folders WHERE name='Norms' AND parent_id IN (SELECT id FROM journal_folders WHERE is_kb_root=1)").get() as {id:number}|undefined;
if (!folder) throw new Error('Library/Norms is not initialized');
const old = db.prepare('SELECT title FROM user_notes WHERE id=?').get(DELIVERY_STANDARD_NOTE_ID) as {title:string}|undefined;
if (old && old.title !== title) throw new Error('The regulation ID belongs to another note');
const content = markdownToTiptap(markdown);
if (!tiptapToMarkdown(content).includes("git add -A")) throw new Error("Regulation markdown round-trip failed");
db.transaction(() => {
  db.prepare("INSERT INTO user_notes(id,title,content,folder_id,kb_category) VALUES(?,?,?,?, 'Norms') ON CONFLICT(id) DO UPDATE SET title=excluded.title,content=excluded.content,folder_id=excluded.folder_id,kb_category='Norms',updated_at=datetime('now')").run(DELIVERY_STANDARD_NOTE_ID,title,content,folder.id);
  const index = db.prepare("SELECT id,content FROM user_notes WHERE folder_id=? AND title='_index.md'").get(folder.id) as {id:string;content:string}|undefined;
  if (index) {
    const decoded = JSON.parse(index.content);
    const current = tiptapToMarkdown(decoded);
    if (typeof decoded === "string") db.prepare("UPDATE user_notes SET content=? WHERE id=?").run(decoded,index.id);
    if (!current.includes(DELIVERY_STANDARD_NOTE_ID)) {
      const next = current.trimEnd()+`\n\n- [${title}](https://192.168.1.110:5180/notes/${DELIVERY_STANDARD_NOTE_ID}) — отчёт, передача своей части, безопасный итоговый коммит и интеграция.\n`;
      db.prepare("UPDATE user_notes SET content=?,updated_at=datetime('now') WHERE id=?").run(markdownToTiptap(next),index.id);
    }
  }
})();
const roles = db.prepare('SELECT key FROM roles').all() as {key:string}[];
for (const {key} of roles) ensureRoleHome(key,{refreshSystem:true});
console.log(JSON.stringify({note_id:DELIVERY_STANDARD_NOTE_ID,folder:'Norms',category:'Norms',roles_refreshed:roles.length}));
