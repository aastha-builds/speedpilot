/* Smart Slider stand-in: parser-blocking in the head, init on DOMContentLoaded. */
window.N2SS = { slides: 0 };
document.addEventListener('DOMContentLoaded', function () {
  document.querySelectorAll('.n2-ss-slider').forEach(function (s) {
    var slides = s.querySelectorAll('.n2-ss-slide');
    var i = 0;
    window.N2SS.slides += slides.length;
    s.querySelector('.n2-next').addEventListener('click', function () {
      slides[i].classList.remove('n2-active');
      i = (i + 1) % slides.length;
      slides[i].classList.add('n2-active');
    });
  });
});
