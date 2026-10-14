/* Content security policies. Pages allow only their inlined stylesheet and
   script by hash; routes can widen connect-src or frame-ancestors. */

import { CHART_SCRIPT } from "../views/chart-client";
import { CLIENT_SCRIPT } from "../views/client";
import { STYLES } from "../views/layout";

export interface PolicyOptions {
  /** Extra origins the client script may fetch. */
  connect?: readonly string[];
  /** Who may frame the page; nobody by default. */
  frameAncestors?: string;
  /** Where forms may submit; nowhere by default. */
  formAction?: string;
  /** What the page may frame; nothing by default. */
  frame?: readonly string[];
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return `'sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}'`;
}

let hashes: Promise<[string, string, string]> | undefined;
const policies = new Map<string, Promise<string>>();

export function contentSecurityPolicy(options: PolicyOptions = {}): Promise<string> {
  const key = JSON.stringify(options);
  let policy = policies.get(key);
  if (!policy) {
    hashes ??= Promise.all([sha256(STYLES), sha256(CLIENT_SCRIPT), sha256(CHART_SCRIPT)]);
    policy = hashes.then(([style, script, charts]) =>
      [
        "default-src 'none'",
        `style-src ${style}`,
        // Cloudflare injects its Web Analytics beacon into the HTML response.
        `script-src ${script} ${charts} https://static.cloudflareinsights.com`,
        ["connect-src 'self'", ...(options.connect ?? []), "https://cloudflareinsights.com"].join(" "),
        "font-src 'self'",
        ...(options.frame ? [`frame-src ${options.frame.join(" ")}`] : []),
        "img-src 'self' data:",
        "base-uri 'none'",
        `form-action ${options.formAction ?? "'none'"}`,
        `frame-ancestors ${options.frameAncestors ?? "'none'"}`,
      ].join("; "),
    );
    policies.set(key, policy);
  }
  return policy;
}
