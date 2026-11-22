// Progressive enhancement only: fade cards in as they scroll into view. The site works without this.
(function () {
  try {
    if (!('IntersectionObserver' in window) || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    document.documentElement.classList.add('js');
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
    }, { rootMargin: '0px 0px -8% 0px' });
    document.querySelectorAll('.card, .steps li, .stats div, .ticks li, .band').forEach(function (el) {
      el.classList.add('reveal');
      io.observe(el);
    });
  } catch (_) { /* ignore */ }
})();

// Download page: show the newest release's version, date and size, and link straight to its APK.
(function () {
  try {
    var btn = document.getElementById('dl-btn');
    if (!btn || !window.fetch) return;
    fetch('https://api.github.com/repos/Kotti13/Zoyra/releases/latest', { headers: { Accept: 'application/vnd.github+json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (rel) {
        if (!rel || !rel.assets) return;
        var apk = rel.assets.filter(function (a) { return /\.apk$/i.test(a.name); })[0];
        if (!apk) return;
        btn.href = apk.browser_download_url;
        var mb = (apk.size / 1048576).toFixed(0);
        var d = new Date(rel.published_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
        document.getElementById('dl-meta').textContent = rel.name + ' · ' + mb + ' MB · ' + d;
        document.getElementById('dl-note').textContent = 'Built automatically from the public repository.';
      })
      .catch(function () {});
  } catch (_) { /* the plain link still works */ }
})();
