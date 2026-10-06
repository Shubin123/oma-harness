/** Versioned, lossless snapshots. Unsupported values fail instead of disappearing. */
type Encoded = null | boolean | number | string | Encoded[];
function encode(value: unknown, seen: Set<object>): Encoded {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("Cannot serialize non-finite numbers");
    return value;
  }
  if (value === undefined) return ["undefined"];
  if (typeof value === "bigint") return ["bigint", value.toString()];
  if (typeof value !== "object")
    throw new Error(`Cannot serialize ${typeof value}`);
  if (seen.has(value)) throw new Error("Cannot serialize cyclic data");
  seen.add(value);
  try {
    if (value instanceof Date) return ["date", value.toISOString()];
    if (value instanceof Map)
      return [
        "map",
        [...value].map(([k, v]) => [encode(k, seen), encode(v, seen)]),
      ];
    if (value instanceof Set)
      return ["set", [...value].map((v) => encode(v, seen))];
    if (Array.isArray(value))
      return ["array", value.map((v) => encode(v, seen))];
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value)))
      throw new Error("Unsupported object prototype");
    return [
      "object",
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, encode(v, seen)]),
    ];
  } finally {
    seen.delete(value);
  }
}
function decode(value: Encoded): unknown {
  if (!Array.isArray(value)) return value;
  const [tag, data] = value;
  switch (tag) {
    case "undefined":
      return undefined;
    case "bigint":
      return BigInt(data as string);
    case "date":
      return new Date(data as string);
    case "array":
      return (data as Encoded[]).map(decode);
    case "set":
      return new Set((data as Encoded[]).map(decode));
    case "map":
      return new Map(
        (data as Encoded[][]).map(([k, v]) => [decode(k), decode(v)]),
      );
    case "object":
      return Object.fromEntries(
        (data as Encoded[][]).map(([k, v]) => [k, decode(v)]),
      );
    default:
      throw new Error("Unknown snapshot value");
  }
}
export function serialize(value: unknown): string {
  return JSON.stringify({ version: 1, data: encode(value, new Set()) });
}
export function deserialize<T = unknown>(text: string): T {
  const envelope = JSON.parse(text);
  if (envelope.version !== 1 || !("data" in envelope))
    throw new Error("Unsupported snapshot version");
  return decode(envelope.data) as T;
}
export function snapshot<T>(value: T): T {
  return deserialize<T>(serialize(value));
}
