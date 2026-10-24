/* Fixture "third-party" chat widget (3P-04, JS-11). Served from a second origin so ownership is third-party. */
(function () {
  var start = Date.now();
  var arr = [];
  while (Date.now() - start < 90) arr.push(Math.random());
  var s = document.createElement('script');
  s.src = (document.currentScript && document.currentScript.src.replace(/widget\.js.*$/, '')) + 'widget-core.js';
  document.head.appendChild(s);
  window.ChatFixture = { loaded: true, open: function () { document.body.classList.add('chat-open'); } };
  setInterval(function () { fetch((window.ChatFixtureBase || '') + '/chat/ping', { mode: 'no-cors' }).catch(function () {}); }, 15000);
})();
