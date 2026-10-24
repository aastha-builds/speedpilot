/* Theme behaviour: mobile menu, variant select, cart count. Already deferred. */
document.addEventListener('DOMContentLoaded', function () {
  var t = document.querySelector('.header__menu-toggle');
  var m = document.getElementById('HeaderMenu');
  if (t && m) t.addEventListener('click', function () { var o = m.classList.toggle('is-open'); t.setAttribute('aria-expanded', String(o)); });
  var sel = document.querySelector('[data-variant-select]');
  var price = document.querySelector('[data-price]');
  if (sel && price) sel.addEventListener('change', function () { price.textContent = sel.selectedOptions[0].getAttribute('data-price'); });
  var form = document.querySelector('[data-product-form]');
  if (form) form.addEventListener('submit', function (e) {
    e.preventDefault();
    fetch('/cart/add.js', { method: 'POST', body: new FormData(form) }).then(function (r) { return r.json(); }).then(function (c) {
      var n = document.querySelector('[data-cart-count]');
      if (n) n.textContent = String(c.item_count);
    });
  });
});
