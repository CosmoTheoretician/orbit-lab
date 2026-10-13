/** Small "under development" notice with the time of the last code change (commit time, injected at build). */
export function createDevBadge() {
  const when = new Date(__LAST_UPDATE__);
  const stamp = Number.isNaN(when.getTime()) ? __LAST_UPDATE__ : when.toISOString().slice(0, 16).replace("T", " ") + " UTC";

  const el = document.createElement("div");
  el.textContent = `Under development · last update ${stamp} · ${__COMMIT__}`;
  Object.assign(el.style, {
    position: "fixed", top: "8px", right: "10px", zIndex: "10",
    color: "#7f93ad", font: "10px ui-monospace, monospace", pointerEvents: "none",
  });
  document.body.appendChild(el);
}
