/* Ink/Mono theme toggle — persists in localStorage (`rsw-theme`). */
(function () {
  var KEY = 'rsw-theme';
  function apply(theme) {
    var t = theme === 'light' ? 'light' : 'dark';
    if (t === 'light') document.documentElement.setAttribute('data-theme', 'light');
    else document.documentElement.removeAttribute('data-theme');
    try { localStorage.setItem(KEY, t); } catch (e) { /* ignore */ }
  }
  function current() {
    try { return localStorage.getItem(KEY) || 'dark'; } catch (e) { return 'dark'; }
  }
  apply(current());
  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('[data-theme-toggle]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        apply(current() === 'light' ? 'dark' : 'light');
      });
    });
  });
})();
