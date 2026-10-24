/* PLANTED JS-01: a jQuery plugin loaded parser-blocking in the head. Inline code after it checks $.fn.spfSlider. */
(function ($) {
  'use strict';
  // simulate a heavy library parse/eval cost at load (JS-03)
  var start = Date.now();
  var junk = [];
  while (Date.now() - start < 120) { junk.push(Math.sqrt(junk.length)); }
  $.fn.spfSlider = function () {
    return this.each(function () { $(this).addClass('spf-slider'); });
  };
  window.SPF_SLIDER_VERSION = '1.0.0';
})(window.jQuery);
