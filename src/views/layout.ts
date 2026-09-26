/* The document shell: head, top bar, and footer. The stylesheet, logo and
   script are inlined, so a page paints after one request plus the preloaded
   font. */

import logo from "../assets/logo.svg?raw";
import { html, raw, type Html } from "../html";
import styles from "../styles/index.css?inline";
import { CLIENT_SCRIPT, REFRESH_SECONDS } from "./client";

export const STYLES = styles;

const NAV = [
  { href: "/", label: "Status" },
  { href: "/uptime", label: "Uptime" },
  { href: "/ping", label: "Ping" },
  { href: "/history", label: "History" },
  { href: "/maintenance", label: "Maintenance" },
  { href: "/subscribe", label: "Subscribe" },
] as const;

export interface Page {
  title: string;
  description: string;
  /** The nav entry the page belongs to. */
  path: (typeof NAV)[number]["href"] | null;
  /** The page's <main>; live pages mark it data-live to refresh in place. */
  body: Html;
  live?: boolean;
  /** Only the page itself, without the top bar and footer (the widget). */
  bare?: boolean;
}

function top(page: Page): Html {
  return html`<a class="ts-skip-link" href="#main">Skip to main content</a>
<header class="st-top">
  <div class="st-frame">
    <a class="st-brand" href="/" aria-label="TerraScale status home">${raw(logo)}</a>
    <div class="st-top-end">
      <nav class="st-nav" aria-label="Status pages">
        ${NAV.map((item) => html`<a href="${item.href}"${page.path === item.href ? raw(' aria-current="page"') : ""}>${item.label}</a>`)}
      </nav>
      <label class="st-zone" hidden>
        <span class="ts-sr-only">Time zone</span>
        <select id="st-zone" class="ts-select ts-select-sm"></select>
      </label>
    </div>
  </div>
</header>`;
}

function bottom(year: number): Html {
  return html`<div id="st-live" class="ts-sr-only" aria-live="polite"></div>
<footer class="st-foot">
  <div class="st-frame">
    <span>© ${year} TerraScale</span>
    <nav aria-label="More">
      <a href="https://terrascale.tech">terrascale.tech</a>
      <a href="/integrations">Integrations</a>
      <a href="/feed.atom">Feed</a>
      <a href="/api/v1/status">JSON API</a>
    </nav>
  </div>
</footer>`;
}

export function document(page: Page, year: number): Html {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#0a0c12">
<title>${page.title}</title>
<meta name="description" content="${page.description}">
<link rel="icon" type="image/svg+xml" href="/icon.svg">
<link rel="alternate" type="application/atom+xml" title="TerraScale Status" href="/feed.atom">
<link rel="preload" href="/fonts/oxanium.woff2" as="font" type="font/woff2" crossorigin>
<style>${raw(STYLES)}</style>
${page.live ? html`<noscript><meta http-equiv="refresh" content="${REFRESH_SECONDS}"></noscript>` : ""}
</head>
<body>
${page.bare ? "" : top(page)}
${page.body}
${page.bare ? "" : bottom(year)}
<script>${raw(CLIENT_SCRIPT)}</script>
</body>
</html>`;
}
