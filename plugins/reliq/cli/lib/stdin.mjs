// stdin.mjs — read all of process.stdin as a string, tolerant of no-stdin (TTY).

export function readStdin({ stream = process.stdin, timeoutMs = 2000 } = {}) {
  return new Promise((resolve) => {
    // If stdin is a TTY (interactive, no piped hook payload), resolve empty
    // immediately so the CLI never hangs waiting for input.
    if (stream.isTTY) return resolve("");
    let data = "";
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve(data);
    };
    // Guard against a stdin that's open but never delivers EOF.
    const timer = setTimeout(done, timeoutMs);
    timer.unref?.();
    stream.setEncoding("utf8");
    stream.on("data", (c) => {
      data += c;
    });
    stream.on("end", () => {
      clearTimeout(timer);
      done();
    });
    stream.on("error", () => {
      clearTimeout(timer);
      done();
    });
  });
}
