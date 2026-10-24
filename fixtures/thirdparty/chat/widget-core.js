/* More chat widget code loaded by widget.js. */
(function () {
  var bubble = document.getElementById('chat-bubble');
  if (bubble) bubble.addEventListener('click', function () { window.ChatFixture && window.ChatFixture.open(); });
  var start = Date.now();
  while (Date.now() - start < 60) { /* busy */ }
})();
