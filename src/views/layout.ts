/* The document shell: head, top bar, and footer. The stylesheet, logo and
   script are inlined, so a page paints after one request plus the preloaded
   font. */

import logo from "../assets/logo.svg?raw";
import { HEADLINES, stateAttr, type Status } from "../domain/status";
import { html, raw, type Html } from "../html";
import styles from "../styles/index.css?inline";
import { CLIENT_SCRIPT, REFRESH_SECONDS } from "./client";
import { icon } from "./icons";

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
  /** The overall status, for the footer's live status link. */
  status?: Status;
}

function links(page: Page): Html {
  return html`${NAV.map((item) => html`<a href="${item.href}"${page.path === item.href ? raw(' aria-current="page"') : ""}>${item.label}</a>`)}`;
}

/* The sticky, frosted top bar. Wide screens show the page links inline;
   phones fold them into a menu that works without scripts. The time zone
   control needs the client script, so it starts hidden. */
function top(page: Page): Html {
  return html`<a class="ts-skip-link" href="#main">Skip to main content</a>
<header class="st-top">
  <div class="st-frame">
    <a class="st-brand" href="/" aria-label="TerraScale status home">${raw(logo)}</a>
    <nav class="st-nav" aria-label="Status pages">${links(page)}</nav>
    <div class="st-tools">
      <label class="st-zone" title="Time zone" hidden>
        ${icon("globe")}
        <span class="ts-sr-only">Time zone</span>
        <select id="st-zone" class="ts-select ts-select-sm"></select>
      </label>
      <details class="st-menu">
        <summary class="st-icon-button" aria-label="Menu">${icon("menu")}</summary>
        <nav class="st-menu-panel" aria-label="Status pages">${links(page)}</nav>
      </details>
    </div>
  </div>
</header>`;
}

/* The footer: logo, links, and the live status link every TerraScale app
   carries (a pulsing state dot and the headline). */
function bottom(page: Page, year: number): Html {
  return html`<div id="st-live" class="ts-sr-only" aria-live="polite"></div>
<footer class="st-foot">
  <div class="st-frame">
    <a class="st-foot-brand" href="/" aria-label="TerraScale status home">${raw(logo)}</a>
    <span>© ${year} TerraScale</span>
    <nav aria-label="More">
      <a href="https://terrascale.tech">terrascale.tech</a>
      <a href="https://docs.terrascale.tech">Docs</a>
      <a href="/integrations">Integrations</a>
      <a href="/feed.atom">Feed</a>
      <a href="/api/v1/status">JSON API</a>
    </nav>
    <a class="st-status-link" href="/" data-state="${page.status ? stateAttr(page.status) : "none"}"><span class="ts-dot ts-dot-live" aria-hidden="true"></span>${page.status ? HEADLINES[page.status] : "Current status"}</a>
  </div>
</footer>`;
}

/** The page document. ts-status is dark only: data-theme="dark" picks the
    dark values of whichever design tokens file is in place. */
export function document(page: Page, year: number): Html {
  return html`<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#0a0a0a">
<title>${page.title}</title>
<meta name="description" content="${page.description}">
<link rel="icon" type="image/svg+xml" href="/icon.svg">
<link rel="alternate" type="application/atom+xml" title="TerraScale Status" href="/feed.atom">
<link rel="preload" href="/fonts/geist.woff2" as="font" type="font/woff2" crossorigin>
<style>${raw(STYLES)}</style>
${page.live ? html`<noscript><meta http-equiv="refresh" content="${REFRESH_SECONDS}"></noscript>` : ""}
</head>
<body>
${page.bare ? "" : top(page)}
${page.body}
${page.bare ? "" : bottom(page, year)}
<script>${raw(CLIENT_SCRIPT)}</script>
</body>
</html>`;
}
