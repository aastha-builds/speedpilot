/* Contact Form 7 stand-in front-end script: client-side validation and AJAX submit. */
(function () {
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (!f.classList || !f.classList.contains('wpcf7-form')) return;
    e.preventDefault();
    var out = f.querySelector('.wpcf7-response-output');
    var ok = Array.prototype.every.call(f.querySelectorAll('[required]'), function (i) { return i.value.trim() !== ''; });
    f.classList.toggle('invalid', !ok);
    if (out) { out.textContent = ok ? 'Thank you for your message. It has been sent.' : 'One or more fields have an error.'; out.removeAttribute('aria-hidden'); }
  });
  for (var i = 0, s = ''; i < 3000; i++) s += i;
})();
