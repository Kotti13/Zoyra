// Behaviour for the pages built from the Claude Design canvas. Progressive enhancement: every page reads fine without it.
(function () {
  'use strict';

  // Cursor glow: the pages' CSS reads --mx / --my on the .adv root.
  var adv = document.querySelector('.adv');
  if (adv && matchMedia('(hover: hover)').matches) {
    addEventListener('mousemove', function (e) {
      adv.style.setProperty('--mx', e.clientX + 'px');
      adv.style.setProperty('--my', e.clientY + 'px');
    }, { passive: true });
  }

  var $ = function (id) { return document.getElementById(id); };

  /* ---------------------------------------------------------------- Home: phone player + accent swatches */
  var phone = $('phone');
  if (phone) {
    var presets = [['#FA2D48', 'Red'], ['#FF6F91', 'Pink'], ['#FF6B81', 'Rose'], ['#FDCB6E', 'Amber'], ['#74B9FF', 'Blue'], ['#00B894', 'Green']];
    var accent = presets[0][0];
    var playing = true;
    var toggle = $('play-toggle');
    var box = $('swatches');

    var glow = function (hex) {
      var n = parseInt(hex.slice(1), 16);
      return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',0.55)';
    };
    var render = function () {
      phone.style.setProperty('--acc', accent);
      phone.style.setProperty('--acc-glow', glow(accent));
      phone.classList.toggle('paused', !playing);
      toggle.setAttribute('aria-label', playing ? 'Pause' : 'Play');
      phone.querySelector('[data-when=playing]').style.display = playing ? 'flex' : 'none';
      phone.querySelector('[data-when=paused]').style.display = playing ? 'none' : 'flex';
      box.querySelectorAll('button').forEach(function (b, i) {
        var on = presets[i][0] === accent;
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
        b.style.border = '2px solid ' + (on ? '#FFFFFF' : 'transparent');
        b.style.boxShadow = on ? '0 0 0 3px rgba(255,255,255,0.15)' : 'none';
      });
    };
    presets.forEach(function (p) {
      var b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('aria-label', p[1] + ' accent');
      b.style.cssText = 'width:36px;height:36px;border-radius:50%;padding:0;cursor:pointer;background:' + p[0] + ';transition:all .2s;min-width:36px';
      b.addEventListener('click', function () { accent = p[0]; render(); });
      box.appendChild(b);
    });
    toggle.addEventListener('click', function () { playing = !playing; render(); });
    // The accent also drives the CSS variables used by the phone (they sit on #phone and below).
    phone.parentNode.style.setProperty('--acc', accent);
    render();
    // Elements outside #phone (the swatch bar) do not need the variable, but the glow behind the phone does not either.
  }

  /* ---------------------------------------------------------------- Forever: the request demo */
  var fa = $('fv-a');
  if (fa) {
    var stage = 0;
    var streak = 1;
    var fb = $('fv-b');
    var link = $('fv-link');
    var steps = [
      { n: '1', title: 'Send a request', body: 'Aarav asks Riya to be forever.' },
      { n: '2', title: 'Riya says yes', body: 'Nothing happens until she accepts.' },
      { n: '3', title: 'The ring turns gold', body: 'Every shared song grows the streak.' }
    ];
    var stepsBox = $('fv-steps');
    var rows = steps.map(function (s) {
      var li = document.createElement('li');
      li.innerHTML = '<span></span><span style="display:flex;flex-direction:column;gap:2px"><strong style="font-size:16px;font-weight:600"></strong><span style="font-size:14px;color:#A3A3A3"></span></span>';
      li.children[0].textContent = s.n;
      li.querySelector('strong').textContent = s.title;
      li.querySelector('strong + span').textContent = s.body;
      stepsBox.appendChild(li);
      return li;
    });
    var renderF = function () {
      var forever = stage === 2;
      rows.forEach(function (li, i) {
        var active = i <= stage;
        li.style.cssText = 'display:flex;gap:14px;align-items:center;padding:14px 16px;border-radius:18px;transition:all .3s ease;' +
          (i === stage ? 'background:rgba(255,176,32,0.1);border:1px solid rgba(255,176,32,0.35);' : 'background:transparent;border:1px solid rgba(255,255,255,0.06);');
        li.children[0].style.cssText = 'flex:0 0 auto;width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;transition:all .3s ease;' +
          (active ? 'background:#FFB020;color:#050505;' : 'background:#1E1E1E;color:#A3A3A3;');
      });
      var ring = forever ? '#FFB020' : (stage === 1 ? 'rgba(255,176,32,0.45)' : 'rgba(255,255,255,0.18)');
      var base = 'width:96px;height:96px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:34px;font-weight:300;color:#FFFFFF;transition:all .5s ease;border:4px solid ' + ring + ';';
      fa.style.cssText = base + 'background:linear-gradient(135deg,#FA2D48,#3A0B16);margin-right:' + (forever ? '-6px' : '0') + ';';
      fb.style.cssText = base + 'background:linear-gradient(135deg,#FF6F91,#4A0D14);margin-left:' + (forever ? '-6px' : '0') + ';';
      fa.className = fb.className = forever ? 'ringpulse' : '';
      link.style.cssText = 'height:4px;transition:all .5s ease;border-radius:2px;' +
        (forever ? 'width:28px;background:#FFB020;' : (stage === 1 ? 'width:44px;background:repeating-linear-gradient(90deg,#FFB020 0 6px,transparent 6px 12px);' : 'width:44px;background:rgba(255,255,255,0.12);'));
      document.querySelectorAll('[data-stage]').forEach(function (el) {
        el.style.display = el.getAttribute('data-stage') === ['none', 'pending', 'forever'][stage] ? 'contents' : 'none';
      });
      $('fv-streak').textContent = streak + '-day streak';
    };
    document.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-act]');
      if (!b) return;
      var a = b.getAttribute('data-act');
      if (a === 'send') stage = 1;
      else if (a === 'accept') { stage = 2; streak = 1; }
      else if (a === 'share') streak += 1;
      else if (a === 'reset') { stage = 0; streak = 1; }
      renderF();
    });
    renderF();
  }

  /* ---------------------------------------------------------------- Developer: skill tabs */
  var tabsBox = $('skill-tabs');
  if (tabsBox) {
    var data = {
      languages: [
        { name: 'Python', tag: 'language', note: 'Backends, automation and ERP customisation.' },
        { name: 'JavaScript', tag: 'language', note: 'Web apps, tooling and APIs.' },
        { name: 'HTML + CSS', tag: 'language', note: 'Semantic, responsive pages.' }
      ],
      frontend: [
        { name: 'React', tag: 'ui', note: 'Component-based interfaces.' },
        { name: 'Next.js', tag: 'framework', note: 'Server-rendered and static sites.' },
        { name: 'Tailwind CSS', tag: 'styling', note: 'Fast, consistent styling.' }
      ],
      backend: [
        { name: 'FastAPI', tag: 'python', note: 'Fast, typed APIs and gateways.' },
        { name: 'Frappe Framework', tag: 'erp', note: 'ERP and HRMS customisation.' },
        { name: 'REST APIs', tag: 'api', note: 'Backend API development and integration.' }
      ],
      data: [
        { name: 'PostgreSQL', tag: 'sql', note: 'Database design and integration.' },
        { name: 'Supabase', tag: 'baas', note: 'Auth, row-level security, realtime and edge functions.' },
        { name: 'Firebase', tag: 'baas', note: 'Hosted data and messaging.' }
      ],
      tools: [
        { name: 'Git + GitHub', tag: 'workflow', note: 'Version control and collaboration.' },
        { name: 'Docker', tag: 'ops', note: 'Reproducible builds and hosting.' },
        { name: 'VS Code', tag: 'editor', note: 'Daily editor.' }
      ],
      exploring: [
        { name: 'AI + LLMs', tag: 'learning', note: 'AI-powered application development.' },
        { name: 'Automation', tag: 'learning', note: 'Workflows that remove repeat work.' }
      ]
    };
    var labels = [['languages', 'Languages'], ['frontend', 'Frontend'], ['backend', 'Backend'], ['data', 'Database'], ['tools', 'Tools'], ['exploring', 'Exploring']];
    var area = 'languages';
    var listBox = $('skill-list');
    var renderS = function () {
      tabsBox.querySelectorAll('button').forEach(function (b, i) {
        var on = labels[i][0] === area;
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
        b.style.cssText = on ? 'background:#FA2D48;border-color:#FA2D48;color:#050505;' : '';
      });
      listBox.innerHTML = '';
      data[area].forEach(function (s) {
        var d = document.createElement('div');
        d.className = 'tilt';
        d.style.cssText = 'border-radius:20px;background:rgba(20,20,20,0.7);border:1px solid rgba(255,255,255,0.1);padding:22px;display:flex;flex-direction:column;gap:10px';
        d.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px"><strong style="font-size:18px;font-weight:600"></strong><span style="font-family:\'JetBrains Mono\',monospace;font-size:12px;color:#FA2D48"></span></div><span style="font-size:14px;line-height:1.55;color:#A3A3A3"></span>';
        d.querySelector('strong').textContent = s.name;
        d.querySelector('span').textContent = s.tag;
        d.lastChild.textContent = s.note;
        listBox.appendChild(d);
      });
    };
    labels.forEach(function (l) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'tab';
      b.textContent = l[1];
      b.addEventListener('click', function () { area = l[0]; renderS(); });
      tabsBox.appendChild(b);
    });
    renderS();
  }

  /* ---------------------------------------------------------------- Download: newest release */
  var dl = $('dl-btn');
  if (dl && window.fetch) {
    fetch('https://api.github.com/repos/Kotti13/Zoyra/releases/latest', { headers: { Accept: 'application/vnd.github+json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (rel) {
        if (!rel || !rel.assets) return;
        var apk = rel.assets.filter(function (a) { return /\.apk$/i.test(a.name); })[0];
        if (!apk) return;
        dl.href = apk.browser_download_url;
        var d = new Date(rel.published_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
        var meta = $('dl-meta');
        if (meta) meta.textContent = rel.name + ' · ' + (apk.size / 1048576).toFixed(0) + ' MB · ' + d;
      })
      .catch(function () { /* the plain link still works */ });
  }
})();
