/**
 * Lightweight structured debug logging. Writes single-line, greppable entries
 * to stdout (captured by PM2: `pm2 logs bahnfinder`). Enabled by default; set
 * DEBUG_BAHN=0 to silence. Prefix `[bahn]` + scope makes filtering easy.
 */
const ON = process.env.DEBUG_BAHN !== "0";

export function dlog(scope: string, msg: string, data?: unknown): void {
  if (!ON) return;
  const ts = new Date().toISOString();
  const head = `[bahn ${ts}] ${scope}: ${msg}`;
  if (data === undefined) {
    // eslint-disable-next-line no-console
    console.log(head);
    return;
  }
  let tail: string;
  try {
    tail = typeof data === "string" ? data : JSON.stringify(data);
  } catch {
    tail = String(data);
  }
  // eslint-disable-next-line no-console
  console.log(`${head} ${tail}`);
}

export function dwarn(scope: string, msg: string, data?: unknown): void {
  const ts = new Date().toISOString();
  const head = `[bahn ${ts}] ${scope}: ${msg}`;
  // eslint-disable-next-line no-console
  console.warn(data === undefined ? head : `${head} ${typeof data === "string" ? data : JSON.stringify(data)}`);
}
