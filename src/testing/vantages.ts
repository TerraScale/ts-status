/* Stands in for the VANTAGE Durable Object namespace: each vantage code
   gets its own stub, and a missing one fails like an unreachable object. */

interface Stub {
  fetch(url: string, init: RequestInit): Promise<Response>;
}

export const vantageNamespace = (stubs: Record<string, Stub>) => ({
  idFromName: (code: string) => code,
  get: (code: string) => stubs[code] ?? { fetch: async () => Promise.reject(new Error(`no vantage ${code}`)) },
});
