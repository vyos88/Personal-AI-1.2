import { createInterface } from 'node:readline';

/**
 * Reads a secret without echoing it, so it never lands in shell history or in
 * the process list. Falls back to reading one line when stdin is not a TTY,
 * which is what makes `echo hunter2 | alpha-admin ...` work in a script.
 */
export function promptSecret(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      const rl = createInterface({ input: process.stdin });
      // Resolve *before* closing: rl.close() emits 'close' synchronously, so
      // closing first lets the close handler settle the promise with '' and
      // the real line is silently discarded.
      rl.once('line', (line) => {
        resolve(line);
        rl.close();
      });
      // Only reached when the stream ends without a line at all.
      rl.once('close', () => resolve(''));
      return;
    }

    process.stdout.write(prompt);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    try {
      stdin.setRawMode(true);
    } catch (error) {
      // isTTY lied, or this console does not actually support raw mode (seen
      // in some Windows terminal wrappers). Falling through to the non-TTY
      // path below at least reads a line instead of hanging with a prompt on
      // screen and no way to answer it.
      process.stdout.write(
        `\n(this terminal cannot hide input; it will be visible as you type)\n`,
      );
      const rl = createInterface({ input: process.stdin });
      rl.once('line', (line) => {
        resolve(line);
        rl.close();
      });
      rl.once('close', () => resolve(''));
      return;
    }
    stdin.resume();
    stdin.setEncoding('utf8');

    let value = '';
    const finish = (fn, arg) => {
      stdin.setRawMode(wasRaw);
      stdin.pause();
      stdin.off('data', onData);
      process.stdout.write('\n');
      fn(arg);
    };

    const onData = (char) => {
      switch (char) {
        case '\n':
        case '\r':
        case '\u0004': // Ctrl-D
          finish(resolve, value);
          break;
        case '\u0003': // Ctrl-C
          finish(reject, new Error('cancelled'));
          break;
        case '\u007f': // backspace
          value = value.slice(0, -1);
          break;
        default:
          value += char;
      }
    };
    stdin.on('data', onData);
  });
}

/** Plain visible line read, for non-secret answers. */
export function promptLine(prompt) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      resolve(answer.trim());
      rl.close();
    });
  });
}
