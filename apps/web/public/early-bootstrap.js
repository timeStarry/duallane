(function () {
  try {
    var p = window.location.pathname || "/";
    var h = window.location.hash || "";
    if (p.indexOf("/direct") !== 0 && h.indexOf("#k=") === -1 && window.fetch) {
      window.__dlEarlyBootstrap = window.fetch("/api/v1/bootstrap", {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
    }
  } catch (_e) {
    // Ignore early prefetch errors
  }
})();
