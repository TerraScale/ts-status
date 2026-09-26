/* Stands in for the workerd-only "cloudflare:sockets" module under Vitest. */

export function connect(): never {
  throw new Error("Sockets are not available in tests; pass a fake connect.");
}
