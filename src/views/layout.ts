/* The document shell: head, top bar, and footer. The stylesheet, logo and
   script are inlined, so a page paints after one request plus the preloaded
   font. */

import logo from "../assets/logo.svg?raw";
import { html, raw, type Html } from "../html";
import styles from "../styles/index.css?inline";
import { CLIENT_SCRIPT, REFRESH_SECONDS } from "./client";

export const STYLES = styles;

const NAV = [
  { href: "/", label: "Overview", icon: "M3 12h4l3-8 4 16 3-8h4" },
  { href: "/history", label: "History", icon: "M3 11a9 9 0 1 1 2 7 M3 4v7h7 M12 7v5l3 2" },
  { href: "/uptime", label: "Uptime", icon: "M4 19V9 M12 19V4 M20 19v-7" },
  { href: "/ping", label: "Ping", icon: "M3 8a15 15 0 0 1 18 0 M6 12a10 10 0 0 1 12 0 M9 16a5 5 0 0 1 6 0 M12 20h.01" },
  { href: "/maintenance", label: "Maintenance", icon: "M14 6a5 5 0 0 0-6 6L3 17a3 3 0 0 0 4 4l5-5a5 5 0 0 0 6-6l-4 4-4-4 4-4Z" },
  { href: "/subscribe", label: "Subscribe", icon: "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9 M10 21h4" },
] as const;

function icon(path: string): Html {
  return html`<svg class="st-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"></path></svg>`;
}

function navigation(page: Page): Html {
  return html`${NAV.filter((item) => item.href !== "/subscribe").map((item) => html`<a href="${item.href}"${page.path === item.href ? raw(' aria-current="page"') : ""}>${icon(item.icon)}${item.label}</a>`)}
    <a href="https://docs.terrascale.tech">${icon("M12 5v16 M3 3h5l4 2 4-2h5v16h-5l-4 2-4-2H3Z")}Docs</a>
    <a href="https://dash.terrascale.tech">${icon("M3 3h7v7H3Z M14 3h7v7h-7Z M3 14h7v7H3Z M14 14h7v7h-7Z")}Dashboard</a>`;
}

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
    <a class="st-brand" href="/" aria-label="TerraScale status home">${raw(logo)}<span class="st-brand-tag">Status</span></a>
    <nav class="st-nav st-desktop-nav" aria-label="Status pages">${navigation(page)}</nav>
    <div class="st-top-end">
      <label class="st-zone" hidden>
        <span class="ts-sr-only">Time zone</span>
        <select id="st-zone" class="ts-select ts-select-sm"></select>
      </label>
      <a class="ts-button st-subscribe" href="/subscribe">${icon(NAV[5].icon)}Subscribe</a>
      <details class="st-mobile-menu">
        <summary aria-label="Navigation">${icon("M3 6h18 M3 12h18 M3 18h18")}</summary>
        <nav class="st-nav" aria-label="Mobile status pages">${navigation(page)}</nav>
      </details>
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
      <a href="https://docs.terrascale.tech">Docs</a>
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
<meta name="theme-color" content="#151515">
<title>${page.title}</title>
<meta name="description" content="${page.description}">
<link rel="icon" type="image/svg+xml" href="/icon.svg">
<link rel="alternate" type="application/atom+xml" title="TerraScale Status" href="/feed.atom">
<link rel="preload" href="/fonts/Geist-Variable.woff2" as="font" type="font/woff2" crossorigin>
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
