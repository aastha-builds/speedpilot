/* PLANTED JS-04, REV-07: a click handler that blocks the main thread for about 300 ms. */
document.addEventListener('DOMContentLoaded', function () {
  var b = document.getElementById('heavy-button');
  if (!b) return;
  b.addEventListener('click', function spfHeavyClickHandler() {
    var end = performance.now() + 300;
    var x = 0;
    while (performance.now() < end) { x += Math.random(); }
    document.getElementById('offers').hidden = false;
    b.setAttribute('data-x', String(x > 0));
  });
});
