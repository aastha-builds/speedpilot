/* Elementor stand-in frontend: reads elementorFrontendConfig, uses jQuery. */
jQuery(function ($) {
  if (!window.elementorFrontendConfig) throw new Error('elementorFrontendConfig missing');
  $('.elementor-invisible').removeClass('elementor-invisible');
});
