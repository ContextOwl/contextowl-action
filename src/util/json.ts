// Small helpers for reading loosely-typed JSON returned by the REST API, tolerant
// of key casing (Go marshals some structs with capitalized field names).
export type Rec = Record<string, unknown>;

/** Return a copy of `obj` with all top-level keys lowercased. */
export function lc(obj: Rec): Rec {
  const out: Rec = {};
  for (const [k, v] of Object.entries(obj)) out[k.toLowerCase()] = v;
  return out;
}

export function isRec(x: unknown): x is Rec {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

export function asArray(x: unknown): unknown[] {
  return Array.isArray(x) ? x : [];
}

export function str(x: unknown, fallback = ""): string {
  return typeof x === "string" ? x : fallback;
}

export function num(x: unknown, fallback = 0): number {
  return typeof x === "number" && Number.isFinite(x) ? x : fallback;
}

export function bool(x: unknown, fallback = false): boolean {
  return typeof x === "boolean" ? x : fallback;
}

export function strArray(x: unknown): string[] {
  return asArray(x).filter((v): v is string => typeof v === "string");
}
