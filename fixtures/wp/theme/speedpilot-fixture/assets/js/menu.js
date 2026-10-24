/* Mobile menu toggle (used by the navigation flow). */
document.addEventListener('DOMContentLoaded', function () {
  var btn = document.querySelector('.menu-toggle');
  var nav = document.getElementById('primary-nav');
  if (!btn || !nav) return;
  btn.addEventListener('click', function () {
    var open = nav.classList.toggle('is-open');
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
});
