/* PLANTED DOC-04 and DOC-03: entrance animation on above-the-fold elements, preloader removed on window.load. */
(function () {
  function reveal() {
    document.querySelectorAll('.animate-in').forEach(function (el) { el.classList.add('is-visible'); });
  }
  window.addEventListener('load', function () {
    var p = document.getElementById('preloader');
    if (p) p.classList.add('done');
    setTimeout(reveal, 300);
  });
})();
