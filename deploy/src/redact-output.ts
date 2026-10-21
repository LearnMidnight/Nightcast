/**
 * Keep Blockfrost project ids off the terminal.
 *
 * They travel in URLs as `?project_id=...`, and libraries we don't control
 * (the Polkadot RPC client behind the wallet, for one) print those URLs when a
 * connection opens or closes. Nightcast's own logger redacts them; this also
 * filters everything written to stdout and stderr. Import it first.
 */

/** Hide Blockfrost project ids in text. */
export const redact = (text: string): string => text.replace(/(project_id=)[^&\s"'`)]+/g, '$1***');

type Write = typeof process.stdout.write;

/** Wrap a stream's write so project ids are redacted on the way out. */
export const redactingWrite = (original: Write): Write =>
  function (this: NodeJS.WriteStream, chunk: unknown, ...rest: unknown[]) {
    const text =
      typeof chunk === 'string' ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk).toString('utf8') : undefined;
    const out = text !== undefined && text.includes('project_id=') ? redact(text) : chunk;
    return (original as (...args: unknown[]) => boolean).call(this, out, ...rest);
  } as Write;

let installed = false;

/** Redact project ids in everything written to stdout and stderr (idempotent). */
export const redactProcessOutput = (): void => {
  if (installed) return;
  installed = true;
  process.stdout.write = redactingWrite(process.stdout.write.bind(process.stdout));
  process.stderr.write = redactingWrite(process.stderr.write.bind(process.stderr));
};

redactProcessOutput();
