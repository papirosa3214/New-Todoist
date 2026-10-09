import Database from 'better-sqlite3';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const mod = require('./src/migrations.js');
console.log('keys:', Object.keys(mod));
console.log('migrations type:', typeof mod.migrations, Array.isArray(mod.migrations) ? 'array' : 'NOT array');
const arr = Array.isArray(mod.migrations) ? mod.migrations : Object.values(mod.migrations);
console.log('len:', arr.length, 'first id:', arr[0]?.id, 'last id:', arr[arr.length-1]?.id);
