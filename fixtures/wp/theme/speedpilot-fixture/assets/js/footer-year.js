/* Safe to defer: no globals, no dependents, waits for DOMContentLoaded. */
document.addEventListener('DOMContentLoaded', function () {
  var el = document.getElementById('footer-year');
  if (el) el.textContent = String(new Date().getFullYear());
});
