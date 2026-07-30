export const EMBED_FRAME_SCRIPT = String.raw`(function () {
  if (window.top === window.self) return;

  var last = 0;
  var queued = false;
  var documentRoot = document.documentElement;
  var embedRoot = document.querySelector("[data-imsda-embed-root]");

  function measure() {
    if (embedRoot) {
      return Math.ceil(Math.max(
        embedRoot.scrollHeight,
        embedRoot.offsetHeight,
        embedRoot.getBoundingClientRect().height
      ));
    }

    var body = document.body;
    return Math.ceil(Math.max(
      body ? body.scrollHeight : 0,
      documentRoot.scrollHeight,
      body ? body.offsetHeight : 0,
      documentRoot.offsetHeight
    ));
  }

  function send() {
    queued = false;
    var height = measure();
    if (!height || Math.abs(height - last) < 2) return;
    last = height;
    window.parent.postMessage({
      type: "imsda:embed",
      event: "height",
      height: height
    }, "*");
  }

  function schedule() {
    if (queued) return;
    queued = true;
    window.requestAnimationFrame(send);
  }

  document.addEventListener("DOMContentLoaded", schedule);
  window.addEventListener("load", schedule);

  if ("ResizeObserver" in window) {
    var resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(documentRoot);
    if (embedRoot) resizeObserver.observe(embedRoot);
  }

  if ("MutationObserver" in window) {
    new MutationObserver(schedule).observe(documentRoot, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true
    });
  }

  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(schedule);
  }

  window.setInterval(schedule, 1000);
  window.imsdaEmbedScrollTop = function () {
    window.parent.postMessage({
      type: "imsda:embed",
      event: "scrollTop"
    }, "*");
  };

  schedule();
})();`;

export const EMBED_HOST_SCRIPT = String.raw`(function () {
  var script = document.currentScript;
  if (!script || !script.src) return;

  var origin;
  try {
    origin = new URL(script.src, document.baseURI).origin;
  } catch (_) {
    return;
  }

  var registeredOrigins = window.__imsdaEmbedHostOrigins
    || (window.__imsdaEmbedHostOrigins = []);
  if (registeredOrigins.indexOf(origin) !== -1) return;
  registeredOrigins.push(origin);

  window.addEventListener("message", function (messageEvent) {
    if (messageEvent.origin !== origin) return;
    var data = messageEvent.data;
    if (!data || data.type !== "imsda:embed") return;

    var frames = document.querySelectorAll(
      'iframe.imsda-embed, iframe[src^="' + origin + '/embed/"]'
    );

    for (var index = 0; index < frames.length; index += 1) {
      var frame = frames[index];
      if (frame.contentWindow !== messageEvent.source) continue;

      if (
        data.event === "height"
        && typeof data.height === "number"
        && Number.isFinite(data.height)
        && data.height > 0
      ) {
        frame.style.height = Math.ceil(data.height + 16) + "px";
      }

      if (data.event === "scrollTop") {
        frame.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      break;
    }
  });
})();`;
