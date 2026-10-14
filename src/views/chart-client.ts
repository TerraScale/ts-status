/* The line charts' interactions, inlined beside CLIENT_SCRIPT and allowed by
   its own CSP hash. Every listener sits on the document, so charts swapped in
   by the live refresh keep working. The server-rendered hover columns stay
   the only per-sample DOM: pointer, touch and keys pick the nearest column,
   which shows its guide and dots (the crosshair) while one frosted HTML
   tooltip, filled from the column's data-tip JSON as text, replaces the SVG
   one. Arrow keys move between columns (Shift by ten), Home and End jump to
   the ends, Escape hides; the chart is one tab stop once entered. */

export const CHART_SCRIPT = `(() => {
  document.documentElement.dataset.charts = "";
  const tip = document.createElement("div");
  tip.className = "ts-chart-float";
  tip.id = "st-chart-tooltip";
  tip.setAttribute("role", "tooltip");
  tip.hidden = true;
  document.body.append(tip);
  let active = null;

  const columnsOf = (chart) => [...chart.querySelectorAll(".ts-chart-column")];
  const guideX = (column) => {
    const box = column.querySelector(".ts-chart-guide").getBoundingClientRect();
    return box.left + box.width / 2;
  };
  const nearest = (chart, x) => {
    let best = null;
    let distance = Infinity;
    for (const column of columnsOf(chart)) {
      const gap = Math.abs(guideX(column) - x);
      if (gap < distance) [best, distance] = [column, gap];
    }
    return best;
  };

  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };

  const show = (column) => {
    if (!column) return;
    let data = {};
    try {
      data = JSON.parse(column.dataset.tip || "{}");
    } catch {
      // Malformed content: the crosshair still shows.
    }
    const parts = data.head ? [node("div", "ts-chart-float-head", data.head)] : [];
    for (const [name, value, series] of Array.isArray(data.rows) ? data.rows : []) {
      const row = node("div", "ts-chart-float-row");
      row.append(node("i", "ts-chart-float-key " + series), node("b", "", value), node("span", "", name));
      parts.push(row);
    }
    tip.replaceChildren(...parts);
    if (active !== column) active?.classList.remove("is-active");
    active = column;
    column.classList.add("is-active");
    column.closest("svg[data-chart]").setAttribute("aria-describedby", "st-chart-tooltip");
    tip.hidden = false;
    // Beside the guide, flipping left near the right edge, level with the plot top.
    const x = guideX(column);
    const top = column.querySelector(".ts-chart-hit").getBoundingClientRect().top;
    const width = tip.offsetWidth;
    const left = x + 14 + width <= innerWidth - 8 ? x + 14 : Math.max(8, x - 14 - width);
    tip.style.left = left + "px";
    tip.style.top = Math.max(8, top) + "px";
  };

  const hide = () => {
    tip.hidden = true;
    active?.classList.remove("is-active");
    active?.closest("svg[data-chart]")?.removeAttribute("aria-describedby");
    active = null;
  };

  const chartOf = (target) => (target instanceof Element ? target.closest("svg[data-chart]") : null);
  const track = (event) => {
    const chart = chartOf(event.target);
    if (chart) show(nearest(chart, event.clientX));
    // A tap elsewhere, or a live refresh replacing the chart, closes it.
    else if (active && (event.type === "pointerdown" || !active.isConnected)) hide();
  };
  // Touch keeps its pointer captured by the chart while dragging; the chart
  // allows vertical panning only, so a horizontal drag scrubs.
  document.addEventListener("pointermove", track);
  document.addEventListener("pointerdown", track);
  document.addEventListener("pointerout", (event) => {
    if (event.pointerType === "mouse" && chartOf(event.target) && !chartOf(event.relatedTarget)) hide();
  });

  // A focused column becomes its chart's only tab stop, so Tab leaves the chart.
  document.addEventListener("focusin", (event) => {
    const column = event.target instanceof Element ? event.target.closest(".ts-chart-column") : null;
    if (!column) return;
    for (const other of columnsOf(column.ownerSVGElement)) other.tabIndex = other === column ? 0 : -1;
    show(column);
  });
  document.addEventListener("focusout", (event) => {
    if (!(event.relatedTarget instanceof Element && event.relatedTarget.closest(".ts-chart-column"))) hide();
  });
  document.addEventListener("keydown", (event) => {
    const column = event.target instanceof Element ? event.target.closest(".ts-chart-column") : null;
    if (!column) return;
    if (event.key === "Escape") return hide();
    const columns = columnsOf(column.ownerSVGElement);
    const index = columns.indexOf(column);
    const step = event.shiftKey ? 10 : 1;
    const next = { ArrowLeft: index - step, ArrowRight: index + step, Home: 0, End: columns.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    columns[Math.max(0, Math.min(columns.length - 1, next))].focus();
  });
  addEventListener("scroll", () => active && hide(), { passive: true });
  addEventListener("resize", () => active && hide());
})();`;
