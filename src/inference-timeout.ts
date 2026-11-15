export interface InferenceTimeout {
  readonly total?: number | false;
  readonly headers?: number | false;
  readonly chunk?: number | false;
}

export function inferenceTimeout(value: unknown): InferenceTimeout | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number' || value === false) value = { total: value };
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Invalid inference timeout');
  const result: Record<string, number | false> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !['total', 'headers', 'chunk'].includes(key)) throw new Error('Invalid inference timeout');
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (descriptor.get || descriptor.set) throw new Error('Invalid inference timeout');
    const part: unknown = descriptor.value;
    if (part === undefined) continue;
    if (part !== false && (typeof part !== 'number' || !Number.isFinite(part) || part < 0)) throw new Error('Invalid inference timeout');
    result[key] = part as number | false;
  }
  return Object.freeze(result);
}

export function inferenceDeadline(controller: AbortController, milliseconds: number | false | undefined): () => void {
  if (typeof milliseconds !== 'number' || controller.signal.aborted) return () => {};
  let timer: ReturnType<typeof setTimeout>;
  const clear = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', clear); };
  const schedule = (remaining: number) => {
    const delay = Math.min(remaining, 2_147_483_647);
    timer = setTimeout(() => {
      if (remaining > delay) schedule(remaining - delay);
      else controller.abort();
    }, delay);
  };
  controller.signal.addEventListener('abort', clear, { once: true });
  schedule(milliseconds);
  return clear;
}
