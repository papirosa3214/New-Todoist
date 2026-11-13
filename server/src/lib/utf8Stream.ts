// 13.11.2026: один декодер на поток вместо `chunk.toString("utf8")` на каждом куске.
//
// `chunk.toString("utf8")` декодирует каждый кусок отдельно: если
// многобайтная буква попала на границу кусков (stdout процесса, тело
// HTTP-запроса), обе половины становятся U+FFFD — «Корневог�� README.md»
// вместо «Корневого». StringDecoder держит неполный хвост до следующего
// куска и склеивает букву правильно.
import { StringDecoder } from "node:string_decoder";

export type Utf8StreamDecoder = {
  /** Принять очередной кусок. Возвращает текст, готовый к добавлению. */
  write: (chunk: Uint8Array | string) => string;
  /** Закрыть поток. Возвращает остаток; U+FFFD — только если хвост
   *  действительно оборван (поток кончился на середине буквы). */
  end: () => string;
};

export function createUtf8StreamDecoder(): Utf8StreamDecoder {
  const decoder = new StringDecoder("utf8");
  return {
    write(chunk) {
      if (typeof chunk === "string") return chunk;
      return decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    },
    end() {
      return decoder.end();
    },
  };
}
