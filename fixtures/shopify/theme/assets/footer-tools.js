/* Parser-blocking but independent: nothing reads its globals and it only runs on DOMContentLoaded. Safe to defer. */
document.addEventListener('DOMContentLoaded', function () {
  document.querySelectorAll('a[href^="http"]').forEach(function (a) { if (a.host !== location.host) a.rel = 'noopener'; });
});
