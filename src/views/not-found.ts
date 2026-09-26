import { html } from "../html";
import { empty } from "./components";
import type { Page } from "./layout";

export function notFoundPage(): Page {
  return {
    title: "Page not found · TerraScale Status",
    description: "This page does not exist.",
    path: null,
    body: html`<main id="main" class="ts-page">
  <h1 class="ts-sr-only">Page not found</h1>
  ${empty("Page not found", "This page does not exist. The current platform status is on the home page.")}
  <p><a class="ts-link" href="/">Back to current status</a></p>
</main>`,
  };
}
