/* Fixture analytics base tag. Sends beacons to <origin>/g/collect like GA4, so beacon blocking and the tracking guard can be tested. */
(function () {
  var origin = document.currentScript ? new URL(document.currentScript.src).origin : '';
  function send(name, params) {
    var q = 'v=2&tid=G-FIXTURE&en=' + encodeURIComponent(name) + '&dl=' + encodeURIComponent(location.href);
    for (var k in params || {}) q += '&' + encodeURIComponent('ep.' + k) + '=' + encodeURIComponent(params[k]);
    try { navigator.sendBeacon(origin + '/g/collect?' + q); } catch (e) { new Image().src = origin + '/g/collect?' + q; }
  }
  window.spfTrack = send;
  send('page_view');
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest && e.target.closest('.add_to_cart_button, [name="add"], .single_add_to_cart_button, button[data-add-to-cart]');
    if (t) send('add_to_cart', { item: t.getAttribute('data-product_id') || t.value || 'x' });
  }, true);
})();
