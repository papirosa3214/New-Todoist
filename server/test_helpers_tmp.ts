import { getKbRoot, isKbRoot, isUnderKbRoot, pathToFolder, notePathToKbRoot } from './src/lib/notesFolders.js';

console.log('getKbRoot():', JSON.stringify(getKbRoot()));
console.log('isKbRoot(182):', isKbRoot(182));    // ожидаем true
console.log('isKbRoot(183):', isKbRoot(183));    // ожидаем false
console.log('isUnderKbRoot(182):', isUnderKbRoot(182)); // true
console.log('isUnderKbRoot(183):', isUnderKbRoot(183)); // true (Roles под корнем)
console.log('isUnderKbRoot(8):', isUnderKbRoot(8));      // false
console.log('pathToFolder(183):', pathToFolder(183));    // ["TaskFlow Library","Roles"]
console.log('pathToFolder(186):', pathToFolder(186));    // ["TaskFlow Library","Knowledge Base"]
console.log('pathToFolder(3):', pathToFolder(3));        // []
console.log('notePathToKbRoot(183):', notePathToKbRoot(183)); // ["TaskFlow Library","Roles"]
console.log('notePathToKbRoot(null):', notePathToKbRoot(null)); // []
