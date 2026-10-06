/** SSE framing across arbitrary byte boundaries, CRLF, comments and multiline data. */
export async function* readEvents(
  response: Response,
): AsyncGenerator<Record<string, any>> {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (!response.body) throw new Error("Missing response stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "",
    data: string[] = [],
    eventName = "";
  const line = (value: string): Record<string, any> | undefined => {
    value = value.replace(/\r$/, "");
    if (value === "") {
      const raw = data.join("\n");
      data = [];
      const name = eventName;
      eventName = "";
      if (!raw || raw === "[DONE]") return;
      let event;
      try {
        event = JSON.parse(raw);
      } catch {
        throw new Error("Malformed provider stream event");
      }
      if (!event || typeof event !== "object")
        throw new Error("Malformed provider stream event");
      return { ...event, type: event.type || name };
    }
    if (value.startsWith("data:")) data.push(value.slice(5).replace(/^ /, ""));
    else if (value.startsWith("event:")) eventName = value.slice(6).trim();
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!;
      for (const l of lines) {
        const event = line(l);
        if (event) yield event;
      }
      if (done) {
        if (buffer) {
          const event = line(buffer);
          if (event) yield event;
        }
        const event = line("");
        if (event) yield event;
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export function requestSignal(
  timeout: number,
  opts?: Record<string, unknown>,
): AbortSignal {
  const signal = opts?.signal;
  return signal instanceof AbortSignal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeout)])
    : AbortSignal.timeout(timeout);
}
export function emitDelta(
  opts: Record<string, unknown> | undefined,
  text: string,
): void {
  if (text && typeof opts?.onDelta === "function")
    (opts.onDelta as (text: string) => void)(text);
}
