// ===== Обучающий режим: словарик и подсказки в момент события =====
// Учим не «вообще», а когда это происходит: МКС гаснет — «вошла в тень Земли»,
// над головой цепочка Starlink — «это поезд», самолёт прыгает — «помехи GPS».
(function () {
  const app = window.SkyApp;
  if (!app) return;
  const $ = s => document.querySelector(s);
  const S = app.state;
  const tipsOn = () => app.store.get('tips') !== false;

  // ---------- карточка термина ----------
  function openTerm(key) {
    const g = GLOSSARY[key]; if (!g) return;
    $('#glossTerm').textContent = g.term;
    $('#glossImage').textContent = g.image;
    $('#glossHow').textContent = g.how;
    $('#glossMore').open = false;
    $('#glossSee').innerHTML = (g.see || []).filter(k => GLOSSARY[k])
      .map(k => `<button class="chip" data-term="${k}">${GLOSSARY[k].term}</button>`).join('');
    $('#gloss').hidden = false;
  }
  $('#glossClose').addEventListener('click', () => { $('#gloss').hidden = true; });
  $('#gloss').addEventListener('click', e => { if (e.target.id === 'gloss') $('#gloss').hidden = true; });
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-term]'); if (!b) return;
    e.stopPropagation(); openTerm(b.dataset.term);
  }, true);

  // словарик целиком — в панели
  $('#glossList').innerHTML = Object.entries(GLOSSARY)
    .sort((a, b) => a[1].term.localeCompare(b[1].term, 'ru'))
    .map(([k, g]) => `<button class="chip" data-term="${k}">${g.term}</button>`).join('');
  // термины в постоянных подсказках страницы тоже кликабельны
  document.querySelectorAll('.legend li > span:last-child, .note[data-static], .hint').forEach(el => { el.innerHTML = linkTerms(el.textContent); });

  const tg = $('#tgTips');
  tg.checked = tipsOn();
  tg.addEventListener('change', () => { app.store.set('tips', tg.checked); if (!tg.checked) $('#tips').innerHTML = ''; });

  // ---------- всплывающие подсказки ----------
  function tip(text, term, key) {
    const box = $('#tips');
    while (box.children.length >= 2) box.firstElementChild.remove();
    const el = document.createElement('div');
    el.className = 'tip';
    el.innerHTML = `<div class="tip-text">${text}</div><div class="tip-act">`
      + (key ? `<button data-show="${key}">Показать</button>` : '')
      + (term ? `<button data-term="${term}">Почему так?</button>` : '')
      + `<button class="tip-x" aria-label="Закрыть">×</button></div>`;
    box.appendChild(el);
    setTimeout(() => el.remove(), 15000);
  }
  $('#tips').addEventListener('click', e => {
    const tipEl = e.target.closest('.tip');
    if (e.target.closest('.tip-x')) { tipEl.remove(); return; }
    const show = e.target.closest('[data-show]');
    if (show) { app.select(show.dataset.show); if ($('#ar').hidden) $('#domeBox').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
  });

  // ---------- кто что заметил ----------
  const said = new Map();                              // ключ события → когда говорили (чтобы не повторяться)
  const once = (key, coolMin) => {
    const t = said.get(key);
    if (t && Date.now() - t < coolMin * 60000) return false;
    said.set(key, Date.now()); return true;
  };
  const prev = { sats: new Map(), sunAlt: null };
  const esc = x => String(x).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const name = s => esc(s.sat.name);
  const angle = (a, b) => {
    const D = Math.PI / 180, v = o => [Math.cos(o.alt * D) * Math.sin(o.az * D), Math.cos(o.alt * D) * Math.cos(o.az * D), Math.sin(o.alt * D)];
    const p = v(a), q = v(b);
    return Math.acos(Math.max(-1, Math.min(1, p[0] * q[0] + p[1] * q[1] + p[2] * q[2]))) / D;
  };

  function watch() {
    if (!tipsOn() || S.offsetMin !== 0 || S.playing || !S.snap) { prev.sats.clear(); prev.sunAlt = null; return; }

    // сумерки: Солнце переходит ступени −6°, −12°, −18° вниз
    const sunAlt = S.snap.sun.alt;
    if (prev.sunAlt != null) {
      const steps = [[-0.8, 'Солнце село. Через полчаса-час — лучшее время для спутников: у тебя темнеет, а над головой ещё солнце.'],
        [-6, 'Начались навигационные сумерки: на небе проступают яркие звёзды, а МКС и спутники видны лучше всего.'],
        [-12, 'Астрономические сумерки: горизонт почти растворился, видны созвездия.'],
        [-18, 'Настоящая ночь: Солнце ушло на 18° под горизонт, небо темнее уже не станет.']];
      for (const [lvl, text] of steps) {
        if (prev.sunAlt > lvl && sunAlt <= lvl && once('sun' + lvl, 600)) tip(text, 'twilight');
      }
    }
    prev.sunAlt = sunAlt;

    // главные спутники: появился, погас в тени, вынырнул из тени
    const seen = new Map();
    for (const v of S.satView) {
      if (!v.sat.featured) continue;
      seen.set(v.sat.id, v);
      const was = prev.sats.get(v.sat.id), key = 'sat:' + v.sat.id;
      if (v.visible && v.alt >= 10 && (!was || !was.visible || was.alt < 10) && once('rise' + v.sat.id, 20)) {
        const ps = S.passes.find(p => p.sat.id === v.sat.id && p.end.ms > Date.now());
        tip(`${name(v)} над тобой: ${Math.round(v.alt)}° над горизонтом, ${rumbWord(v.az)}`
          + (ps ? `. Поднимется до ${Math.round(ps.max.alt)}°.` : '.'), 'mirror', key);
      }
      if (was && was.sunlit && !v.sunlit && v.alt > 5 && once('shadow' + v.sat.id, 20)) {
        tip(`${name(v)}: вход в тень Земли на ${rumbWord(v.az)}е — точка гаснет за пару секунд, будто выключили лампочку.`, 'shadow', key);
      }
      if (was && !was.sunlit && v.sunlit && v.alt > 5 && S.snap.sun.alt < -6 && once('emerge' + v.sat.id, 20)) {
        tip(`${name(v)}: выход из тени Земли на ${rumbWord(v.az)}е — точка вспыхивает на ровном месте.`, 'shadow', key);
      }
    }
    prev.sats = seen;

    // поезд Starlink: пять и больше видимых Starlink кучкой
    const sl = S.satView.filter(v => v.sat.kind === 'starlink' && v.visible);
    if (sl.length >= 5 && once('trainCheck', 1)) {
      let best = null, bn = 0;
      for (const a of sl) {
        const n = sl.filter(b => angle(a, b) < 8).length;
        if (n > bn) { bn = n; best = a; }
      }
      if (bn >= 5 && once('train', 30)) {
        tip(`Похоже на «поезд» Starlink: ${bn} спутников цепочкой на ${rumbWord(best.az)}е, ${Math.round(best.alt)}° над горизонтом.`, 'starlinkTrain', 'sat:' + best.sat.id);
      }
    }

    // самолёты: прямо над головой; позиция «прыгает» из-за помех GPS
    for (const v of S.planes.view) {
      const p = v.plane, call = esc(p.call || p.reg || p.id);
      if (v.alt > 60 && once('over' + p.id, 30)) {
        tip(`Прямо над головой: ${call}${p.airline ? ' (' + esc(p.airline) + ')' : ''}, высота ${app.fmt(v.h / 1000, 1)} км.`, 'adsb', 'pl:' + p.id);
      }
      if (p.dubious && once('gps', 45)) {
        tip(`У ${call} сомнительная позиция — похоже на помехи GPS. На купол он нарисован пунктиром.`, 'gps', 'pl:' + p.id);
      }
    }
  }
  setInterval(watch, 2000);

  // для проверок
  window.SkyLearn = { openTerm, tip, watch };
})();
