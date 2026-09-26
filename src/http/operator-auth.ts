/* Operator authentication: a bearer token held in the OPERATOR_TOKEN
   secret. Tokens are compared by their SHA-256 digests in constant time,
   so neither their length nor their content leaks through timing. */

async function digest(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

export async function isOperator(request: Request, token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  const [a, b] = await Promise.all([digest(presented), digest(token)]);
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return difference === 0 && presented.length > 0;
}
