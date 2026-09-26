/* The only script on the site, inlined and allowed by its CSP hash. Pages
   render every time in UTC so they stay cacheable; this script re-renders
   them in the visitor's time zone (their browser's by default, or the one
   picked in the top bar) and refreshes live pages in place. */

export const REFRESH_SECONDS = 30;

export const CLIENT_SCRIPT = `(() => {
  const storageKey = "ts-status-time-zone";
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const isZone = (zone) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: zone });
      return true;
    } catch {
      return false;
    }
  };
  const stored = () => {
    try {
      const zone = localStorage.getItem(storageKey);
      return zone && isZone(zone) ? zone : "";
    } catch {
      return "";
    }
  };
  let zone = stored() || browserZone;

  const styles = {
    datetime: { dateStyle: "medium", timeStyle: "short", hourCycle: "h23" },
    clock: { hour: "2-digit", minute: "2-digit", hourCycle: "h23" },
    seconds: { timeStyle: "medium", hourCycle: "h23" },
  };

  const zoneLabel = () => {
    if (zone === "UTC") return "UTC";
    const part = new Intl.DateTimeFormat("en", { timeZone: zone, timeZoneName: "short" })
      .formatToParts(new Date())
      .find((item) => item.type === "timeZoneName");
    return part ? part.value : zone;
  };

  const localize = (root) => {
    const label = zoneLabel();
    const format = {};
    for (const name in styles) format[name] = new Intl.DateTimeFormat("en", { ...styles[name], timeZone: zone });
    for (const element of root.querySelectorAll("time[data-format]")) {
      element.textContent = format[element.dataset.format].format(new Date(element.dateTime)) + " " + label;
    }
    for (const element of root.querySelectorAll("[data-from]")) {
      const from = format.clock.format(Number(element.dataset.from));
      const to = format.clock.format(Number(element.dataset.to));
      element.dataset.tip = from + "–" + to + " " + label + " · " + element.dataset.label;
    }
    for (const element of root.querySelectorAll("[data-zone]")) element.textContent = label;
  };

  const select = document.getElementById("st-zone");
  if (select && Intl.supportedValuesOf) {
    const zones = Intl.supportedValuesOf("timeZone");
    if (!zones.includes("UTC")) zones.unshift("UTC");
    select.append(
      new Option("Auto (" + browserZone.replaceAll("_", " ") + ")", ""),
      ...zones.map((name) => new Option(name.replaceAll("_", " "), name)),
    );
    select.value = stored();
    select.addEventListener("change", () => {
      zone = select.value || browserZone;
      try {
        if (select.value) localStorage.setItem(storageKey, select.value);
        else localStorage.removeItem(storageKey);
      } catch {
        // Private mode: the choice lasts for this page only.
      }
      localize(document);
    });
    select.closest("[hidden]")?.removeAttribute("hidden");
  }
  localize(document);

  const main = document.querySelector("main[data-live]");
  if (!main) return;
  const interval = ${REFRESH_SECONDS * 1000};
  let last = Date.now();
  let busy = false;
  const refresh = async () => {
    if (busy || document.hidden) return;
    busy = true;
    try {
      const response = await fetch(location.pathname + "?fragment=main", { headers: { accept: "text/html" } });
      if (!response.ok) return;
      const template = document.createElement("template");
      template.innerHTML = await response.text();
      const next = template.content.querySelector("main");
      if (!next) return;
      localize(next);
      document.querySelector("main").replaceWith(next);
      document.title = next.dataset.title || document.title;
      last = Date.now();
    } catch {
      // Offline or failing: keep the last good page and try again later.
    } finally {
      busy = false;
    }
  };
  setInterval(refresh, interval);
  document.addEventListener("visibilitychange", () => Date.now() - last >= interval && refresh());
})();`;
