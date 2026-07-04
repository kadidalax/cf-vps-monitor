export type LimitedBodyResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: 'too_large' };

export type LimitedJsonResult =
  | { ok: true; body: unknown }
  | { ok: false; reason: 'too_large' | 'invalid_json' };

export async function readRequestBytesWithLimit(request: Request, maxBytes: number): Promise<LimitedBodyResult> {
  const declaredLength = Number(request.headers.get('Content-Length') || '0');
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return { ok: false, reason: 'too_large' };
  }

  const stream = request.body;
  if (!stream) return { ok: true, bytes: new Uint8Array() };

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { ok: false, reason: 'too_large' };
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

export async function readJsonWithLimit(request: Request, maxBytes: number): Promise<LimitedJsonResult> {
  const body = await readRequestBytesWithLimit(request, maxBytes);
  if (!body.ok) return body;
  try {
    return { ok: true, body: JSON.parse(new TextDecoder().decode(body.bytes)) };
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
}
