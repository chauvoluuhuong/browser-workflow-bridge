// The bridge's log. Lines go to stderr (where the app that started the bridge keeps them) and to a
// file in the data folder, `bridge.log`, so there is one place to look whichever app runs the bridge:
//   log     what a user may need to know: registered, refused, a run it had to give up
//   debug   every command it carried out and how it answered, each time it asked the server for work
// The file never leaves this computer. Values typed into pages are logged by their length only, and
// page content not at all. It is kept under 2 MB: the older half moves to `bridge.log.1`.
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 2 * 1024 * 1024;

export function createLog(dir) {
  const file = path.join(dir, 'bridge.log');
  let written = 0;
  try {
    mkdirSync(dir, { recursive: true });
    written = statSync(file).size;
  } catch { /* no file yet, or a folder that can't be written: stderr only */ }

  function toFile(line) {
    try {
      if (written > MAX_BYTES) {
        renameSync(file, `${file}.1`);
        written = 0;
      }
      const text = `${new Date().toISOString()} ${process.pid} ${line}\n`;
      appendFileSync(file, text);
      written += text.length;
    } catch { /* logging never stops the bridge */ }
  }

  return {
    file,
    log(message) {
      console.error(`[bridge] ${message}`);
      toFile(message);
    },
    /** BW_DEBUG=1 also prints these; the file always has them. */
    debug(message) {
      if (process.env.BW_DEBUG) console.error(`${new Date().toISOString().slice(11, 23)} [bridge] ${message}`);
      toFile(message);
    },
  };
}
