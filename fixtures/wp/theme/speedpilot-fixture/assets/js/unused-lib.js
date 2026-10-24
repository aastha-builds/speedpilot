/* PLANTED JS-02: a utility library loaded on every page and never used. */
(function (root) {
  var lib = {};
  for (var i = 0; i < 200; i++) {
    lib['fn' + i] = new Function('a', 'b', 'return a + b + ' + i + ';');
  }
  root.SpfUnusedLib = lib;
})(window);
