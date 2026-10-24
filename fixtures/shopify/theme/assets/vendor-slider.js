/* PLANTED SHT-02: a vendor slider library loaded parser-blocking with script_tag. Defines window.VendorSlider, used by inline code right after it. */
(function () {
  var start = Date.now();
  var a = [];
  while (Date.now() - start < 120) a.push(a.length * 2);
  function VendorSlider(opts) { this.opts = opts || {}; this.ready = true; }
  VendorSlider.prototype.mount = function (el) { el.classList.add('vendor-slider'); return this; };
  window.VendorSlider = VendorSlider;
})();
