// ===== Камера и компас: метки поверх живой картинки =====
// Телефон сообщает свою ориентацию тремя углами (alpha — поворот вокруг вертикали по компасу,
// beta — наклон вперёд-назад, gamma — вбок). Мы сразу превращаем их в матрицу поворота:
// у углов есть «шарнирный замок» — когда телефон стоит вертикально, alpha и gamma путаются, а матрица — нет.
// Матрица говорит, куда смотрит камера; каждую метку (азимут, высота) переводим в систему экрана
// и рисуем как через объектив: чем дальше от оси, тем дальше от центра.
(function () {
  const app = window.SkyApp;
  if (!app) return;
  const $ = s => document.querySelector(s);
  const D = Math.PI / 180;
  const root = $('#ar'), video = $('#arVideo'), cv = $('#arCanvas'), g = cv.getContext('2d');

  const ar = {
    on: false,
    R: null,                // сглаженная матрица «телефон → мир» (мир: восток, север, вверх)
    raw: null,              // свежая матрица от датчиков
    lastEvent: 0,
    source: '',             // 'absolute' | 'ios' | 'relative'
    yawFix: app.store.get('arYaw') || 0,     // поправка компаса, градусы (подгонка по светилу)
    fov: app.store.get('arFov') || 66,       // поле зрения вдоль длинной стороны экрана
    look: { az: 180, alt: 25 },              // ручной режим (нет датчиков): водим пальцем
    stream: null, wake: null, hits: [], note: '', noteUntil: 0, W: 0, H: 0, infoAt: 0,
  };

  // ---------- матрицы ----------
  // Углы устройства → матрица (по спецификации W3C, порядок Z-X'-Y''). Строки — мировые оси, столбцы — оси телефона.
  function eulerToMatrix(alpha, beta, gamma) {
    const cz = Math.cos(alpha * D), sz = Math.sin(alpha * D), cx = Math.cos(beta * D), sx = Math.sin(beta * D);
    const cy = Math.cos(gamma * D), sy = Math.sin(gamma * D);
    return [
      cz * cy - sz * sx * sy, -cx * sz, cy * sz * sx + cz * sy,
      cy * sz + cz * sx * sy, cz * cx, sz * sy - cz * cy * sx,
      -cx * sy, sx, cx * cy,
    ];
  }
  function mul(A, B) {
    const C = new Array(9);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) C[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
    return C;
  }
  const rotZ = deg => { const c = Math.cos(deg * D), s = Math.sin(deg * D); return [c, -s, 0, s, c, 0, 0, 0, 1]; };
  // Сглаживание: смешиваем со свежей матрицей и выпрямляем обратно в честный поворот (Грам — Шмидт)
  function blend(A, B, k) {
    const M = A.map((v, i) => v + (B[i] - v) * k);
    const col = c => [M[c], M[3 + c], M[6 + c]];
    const norm = v => { const l = Math.hypot(...v) || 1; return v.map(x => x / l); };
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const x = norm(col(0));
    let y = col(1); const d = dot(x, y); y = norm(y.map((v, i) => v - d * x[i]));
    const z = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
    return [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]];
  }
  const screenAngle = () => (screen.orientation && screen.orientation.angle) || window.orientation || 0;

  // Ручной режим: «камера» смотрит на азимут/высоту из ar.look
  const manualMatrix = () => mul(eulerToMatrix(-ar.look.az, 90 + ar.look.alt, 0), rotZ(screenAngle()));

  // ---------- датчики ----------
  function onOrient(e) {
    if (e.alpha == null || e.beta == null) return;
    if (e.type === 'deviceorientation' && ar.source === 'absolute') return;   // Android: есть событие получше
    let alpha = e.alpha;
    if (e.type === 'deviceorientationabsolute' || e.absolute) ar.source = 'absolute';
    else if (e.webkitCompassHeading != null) { ar.source = 'ios'; alpha = 360 - e.webkitCompassHeading; }  // iPhone: компас отдельно
    else ar.source = 'relative';
    ar.raw = mul(eulerToMatrix(alpha, e.beta, e.gamma || 0), rotZ(screenAngle()));
    ar.lastEvent = performance.now();
  }

  // ---------- проекция ----------
  // Мировое направление (азимут, высота) → точка на экране; null — за спиной
  function toScreen(az, alt) {
    const A = (az - ar.yawFix) * D, h = alt * D, R = ar.R;
    const v = [Math.cos(h) * Math.sin(A), Math.cos(h) * Math.cos(A), Math.sin(h)];
    const dx = R[0] * v[0] + R[3] * v[1] + R[6] * v[2];
    const dy = R[1] * v[0] + R[4] * v[1] + R[7] * v[2];
    const dz = R[2] * v[0] + R[5] * v[1] + R[8] * v[2];
    if (dz > -0.05) return null;                       // камера смотрит вдоль −z телефона
    const f = (Math.max(ar.W, ar.H) / 2) / Math.tan(ar.fov / 2 * D);
    return [ar.W / 2 + f * dx / -dz, ar.H / 2 - f * dy / -dz, dx, dy];
  }
  // Куда смотрит центр экрана
  function centerLook() {
    const R = ar.R, x = -R[2], y = -R[5], z = -R[8];
    return { az: rev(Math.atan2(x, y) / D + ar.yawFix), alt: Math.asin(Math.max(-1, Math.min(1, z))) / D };
  }

  // ---------- что рисовать ----------
  function items() {
    const s = app.state, snap = s.snap, out = [];
    if (!snap) return out;
    for (const t of snap.stars) {
      if (t.alt < -1) continue;
      out.push({ key: 's:' + t.n, az: t.az, alt: t.alt, r: Math.max(1.3, 3.4 - 0.75 * t.m), color: '#eef3ff',
        label: t.m < 1.6 || t.n === 'Полярная' ? t.n : '', dim: true });
    }
    for (const p of snap.planets) if (p.alt > -1) out.push({ key: 'p:' + p.id, az: p.az, alt: p.alt, r: Math.max(3, 4.5 - 0.6 * p.mag), color: '#f3d48b', label: p.name });
    if (snap.sun.alt > -1) out.push({ key: 'sun', az: snap.sun.az, alt: snap.sun.alt, r: 12, color: '#ffc24a', label: 'Солнце' });
    if (snap.moon.alt > -1) out.push({ key: 'moon', az: snap.moon.az, alt: snap.moon.alt, r: 11, color: '#ece8da', label: 'Луна' });
    for (const v of s.satView) {
      const small = v.sat.kind === 'starlink';
      out.push({ key: 'sat:' + v.sat.id, az: v.az, alt: v.alt, r: v.sat.featured ? 4.5 : small ? 1.4 : 2.2,
        color: v.visible ? '#8ef0c4' : 'rgba(170,180,200,0.7)', label: v.sat.featured ? v.sat.name : '' });
    }
    for (const v of s.planes.view) {
      out.push({ key: 'pl:' + v.plane.id, az: v.az, alt: v.alt, r: 5, color: '#ff9f7a', plane: true,
        label: `${v.plane.call || v.plane.reg || v.plane.id} · ${app.fmt(v.h / 1000, 1)} км` });
    }
    return out;
  }

  // ---------- рисование ----------
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    ar.W = root.clientWidth; ar.H = root.clientHeight;
    cv.width = Math.round(ar.W * dpr); cv.height = Math.round(ar.H * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function draw() {
    const W = ar.W, H = ar.H;
    g.clearRect(0, 0, W, H);
    g.lineCap = 'round'; g.textBaseline = 'middle';

    // горизонт: где небо встречается с землёй
    g.strokeStyle = 'rgba(160,220,255,0.75)'; g.lineWidth = 1.6; g.beginPath();
    let pen = false;
    for (let az = 0; az <= 360; az += 2) {
      const p = toScreen(az, 0);
      if (!p) { pen = false; continue; }
      if (!pen) { g.moveTo(p[0], p[1]); pen = true; } else g.lineTo(p[0], p[1]);
    }
    g.stroke();
    g.font = '600 15px "Jura", sans-serif'; g.textAlign = 'center';
    [['С', 0], ['СВ', 45], ['В', 90], ['ЮВ', 135], ['Ю', 180], ['ЮЗ', 225], ['З', 270], ['СЗ', 315]].forEach(([t, az]) => {
      const p = toScreen(az, 0); if (!p) return;
      g.fillStyle = 'rgba(6,10,21,0.55)'; g.beginPath(); g.arc(p[0], p[1] + 16, 13, 0, Math.PI * 2); g.fill();
      g.fillStyle = t === 'С' ? '#ff8a8a' : '#cfe8ff'; g.fillText(t, p[0], p[1] + 16);
    });

    // фигуры созвездий
    const snap = app.state.snap;
    if (snap) {
      const byName = {}; snap.stars.forEach(s => { byName[s.n] = s; });
      g.strokeStyle = 'rgba(124,196,255,0.35)'; g.lineWidth = 1;
      for (const [a, b] of CONSTELLATION_LINES) {
        const s1 = byName[a], s2 = byName[b];
        if (!s1 || !s2 || s1.alt < 0 || s2.alt < 0) continue;
        const p1 = toScreen(s1.az, s1.alt), p2 = toScreen(s2.az, s2.alt);
        if (!p1 || !p2) continue;
        g.beginPath(); g.moveTo(p1[0], p1[1]); g.lineTo(p2[0], p2[1]); g.stroke();
      }
    }

    // метки
    ar.hits = [];
    const sel = app.state.selected && app.state.selected.key;
    let selPt = null, selItem = null;
    g.textAlign = 'left';
    for (const it of items()) {
      const p = toScreen(it.az, it.alt);
      if (it.key === sel) { selItem = it; selPt = p; }
      if (!p || p[0] < -40 || p[0] > W + 40 || p[1] < -40 || p[1] > H + 40) continue;
      g.fillStyle = it.color;
      if (it.plane) {
        g.beginPath(); g.moveTo(p[0], p[1] - 7); g.lineTo(p[0] + 5, p[1] + 5); g.lineTo(p[0] - 5, p[1] + 5); g.closePath(); g.fill();
      } else {
        g.beginPath(); g.arc(p[0], p[1], it.r, 0, Math.PI * 2); g.fill();
      }
      if (it.label) {
        g.font = `${it.dim ? '' : '600 '}${it.dim ? 12 : 14}px "Golos Text", sans-serif`;
        g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,0.6)';
        g.strokeText(it.label, p[0] + it.r + 5, p[1]); g.fillText(it.label, p[0] + it.r + 5, p[1]);
      }
      ar.hits.push({ x: p[0], y: p[1], key: it.key, star: !!it.dim });
    }

    // выбранный объект: кольцо, а если он за краем — стрелка «поверни сюда»
    if (selItem) {
      const onScreen = selPt && selPt[0] > 20 && selPt[0] < W - 20 && selPt[1] > 20 && selPt[1] < H - 20;
      if (onScreen) {
        g.strokeStyle = '#7cc4ff'; g.lineWidth = 2; g.beginPath(); g.arc(selPt[0], selPt[1], 18, 0, Math.PI * 2); g.stroke();
      } else {
        edgeArrow(selItem);
      }
    }

    // перекрестье
    g.strokeStyle = 'rgba(255,255,255,0.8)'; g.lineWidth = 1.5;
    g.beginPath(); g.arc(W / 2, H / 2, 14, 0, Math.PI * 2);
    g.moveTo(W / 2 - 24, H / 2); g.lineTo(W / 2 - 8, H / 2); g.moveTo(W / 2 + 8, H / 2); g.lineTo(W / 2 + 24, H / 2);
    g.moveTo(W / 2, H / 2 - 24); g.lineTo(W / 2, H / 2 - 8); g.moveTo(W / 2, H / 2 + 8); g.lineTo(W / 2, H / 2 + 24);
    g.stroke();
  }

  function edgeArrow(it) {
    // направление в плоскости экрана; если объект за спиной — всё равно показываем, куда поворачиваться
    const A = (it.az - ar.yawFix) * D, h = it.alt * D, R = ar.R;
    const v = [Math.cos(h) * Math.sin(A), Math.cos(h) * Math.cos(A), Math.sin(h)];
    let dx = R[0] * v[0] + R[3] * v[1] + R[6] * v[2], dy = -(R[1] * v[0] + R[4] * v[1] + R[7] * v[2]);
    const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
    const W = ar.W, H = ar.H, m = 46;
    const k = Math.min((W / 2 - m) / Math.abs(dx || 1e-6), (H / 2 - m) / Math.abs(dy || 1e-6));
    const x = W / 2 + dx * k, y = H / 2 + dy * k, ang = Math.atan2(dy, dx);
    g.save(); g.translate(x, y); g.rotate(ang);
    g.fillStyle = '#7cc4ff'; g.beginPath(); g.moveTo(18, 0); g.lineTo(-6, 11); g.lineTo(-6, -11); g.closePath(); g.fill();
    g.restore();
    g.font = '600 13px "Golos Text", sans-serif'; g.textAlign = 'center'; g.fillStyle = '#cfe8ff';
    g.fillText(it.label || 'сюда', Math.max(50, Math.min(W - 50, x - dx * 30)), y - dy * 30);
  }

  // ---------- подписи и подсказки ----------
  function status() {
    const sensor = performance.now() - ar.lastEvent < 1500;
    const c = centerLook();
    let s = `Смотришь: ${rumbWord(c.az)}, ${Math.round(c.alt)}° над горизонтом`;
    if (!sensor) s += ' · датчиков нет — веди пальцем по экрану';
    else if (ar.source === 'relative') s += ' · компас недоступен — подгони по светилу';
    if (performance.now() < ar.noteUntil) s = ar.note;
    $('#arStatus').textContent = s;
  }
  function info() {
    const sel = app.state.selected, card = $('#card'), box = $('#arInfo');
    if (!sel || card.hidden) { box.innerHTML = ''; return; }
    const facts = [...card.querySelectorAll('.card-facts div')].slice(0, 3)
      .map(d => `<span><b>${d.querySelector('dt').textContent}:</b> ${d.querySelector('dd').textContent}</span>`).join('');
    box.innerHTML = `<div class="ar-name">${card.querySelector('.card-name').textContent}`
      + ` <small>${card.querySelector('.card-kind').textContent}</small></div>`
      + `<div class="ar-where">${card.querySelector('.card-where').textContent}</div><div class="ar-facts">${facts}</div>`;
  }
  function say(text) { ar.note = text; ar.noteUntil = performance.now() + 4000; }

  // ---------- цикл кадров ----------
  function frame() {
    if (!ar.on) return;
    requestAnimationFrame(frame);
    const sensor = performance.now() - ar.lastEvent < 1500;
    const target = sensor && ar.raw ? ar.raw : manualMatrix();
    ar.R = ar.R ? blend(ar.R, target, sensor ? 0.2 : 1) : target;
    draw();
    if (performance.now() - ar.infoAt > 400) { ar.infoAt = performance.now(); status(); info(); }
  }

  // ---------- подгонка компаса по светилу ----------
  // Наводишь крестик на Луну (Солнце, планету, яркую звезду) и жмёшь: разницу по азимуту запоминаем.
  function calibrate() {
    const snap = app.state.snap; if (!snap) return;
    const c = centerLook();
    const cands = [{ ...snap.sun, label: 'Солнцу' }, { ...snap.moon, label: 'Луне' }]
      .concat(snap.planets.map(p => ({ ...p, label: p.name })))
      .concat(snap.stars.filter(s => s.m < 1.5).map(s => ({ ...s, label: s.n })))
      .filter(o => o.alt > 0);
    const ang = o => {
      const a = [Math.cos(o.alt * D) * Math.sin(o.az * D), Math.cos(o.alt * D) * Math.cos(o.az * D), Math.sin(o.alt * D)];
      const b = [Math.cos(c.alt * D) * Math.sin(c.az * D), Math.cos(c.alt * D) * Math.cos(c.az * D), Math.sin(c.alt * D)];
      return Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) / D;
    };
    let best = null, bd = 30;
    for (const o of cands) { const d = ang(o); if (d < bd) { bd = d; best = o; } }
    if (!best) { say('Рядом с крестиком нет светила. Наведи на Луну, Солнце или яркую планету.'); return; }
    const delta = ((best.az - c.az + 540) % 360) - 180;
    ar.yawFix = ((ar.yawFix + delta + 540) % 360) - 180;
    app.store.set('arYaw', ar.yawFix);
    const label = best.label === 'Солнцу' || best.label === 'Луне' ? best.label : `«${best.label}»`;
    say(`Подогнал по ${label}: компас ошибался на ${Math.round(Math.abs(delta))}°. Общая поправка ${Math.round(ar.yawFix)}°.`);
  }

  // ---------- вход и выход ----------
  async function open() {
    // iPhone спрашивает разрешение на датчики только прямо по нажатию — поэтому первым делом
    const DOE = window.DeviceOrientationEvent;
    const askIos = DOE && typeof DOE.requestPermission === 'function' ? DOE.requestPermission().catch(() => 'denied') : null;
    app.goNow();                                       // камера показывает «сейчас»
    root.hidden = false; ar.on = true; ar.R = null;
    document.body.style.overflow = 'hidden';
    resize();
    if ('ondeviceorientationabsolute' in window) window.addEventListener('deviceorientationabsolute', onOrient);
    window.addEventListener('deviceorientation', onOrient);
    if (askIos && (await askIos) !== 'granted') say('Без доступа к датчикам движения метки не будут следовать за телефоном.');
    try {
      ar.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 } }, audio: false });
      video.srcObject = ar.stream; await video.play().catch(() => {});
    } catch (e) {
      say('Камера недоступна — показываю метки на тёмном фоне.');
    }
    try { ar.wake = await navigator.wakeLock.request('screen'); } catch (e) { /* экран может погаснуть — не страшно */ }
    requestAnimationFrame(frame);
  }
  function close() {
    ar.on = false; root.hidden = true; document.body.style.overflow = '';
    window.removeEventListener('deviceorientationabsolute', onOrient);
    window.removeEventListener('deviceorientation', onOrient);
    if (ar.stream) { ar.stream.getTracks().forEach(t => t.stop()); ar.stream = null; video.srcObject = null; }
    if (ar.wake) { ar.wake.release().catch(() => {}); ar.wake = null; }
  }

  // ---------- управление ----------
  $('#btnAR').addEventListener('click', open);
  $('#arClose').addEventListener('click', close);
  $('#arCalib').addEventListener('click', calibrate);
  $('#arReset').addEventListener('click', () => { ar.yawFix = 0; app.store.set('arYaw', 0); say('Поправка компаса сброшена.'); });
  const fov = $('#arFov');
  fov.value = ar.fov;
  fov.addEventListener('input', () => { ar.fov = +fov.value; app.store.set('arFov', ar.fov); });
  window.addEventListener('resize', () => { if (ar.on) resize(); });

  // нажатие — выбрать объект; протяжка без датчиков — повернуть «взгляд»
  let drag = null;
  cv.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, moved: false }; });
  cv.addEventListener('pointermove', e => {
    if (!drag || performance.now() - ar.lastEvent < 1500) return;
    const k = ar.fov / Math.max(ar.W, ar.H);
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.hypot(dx, dy) > 4) drag.moved = true;
    ar.look.az = rev(ar.look.az - dx * k); ar.look.alt = Math.max(-10, Math.min(90, ar.look.alt + dy * k));
    drag.x = e.clientX; drag.y = e.clientY;
  });
  cv.addEventListener('pointerup', e => {
    const moved = drag && drag.moved; drag = null;
    if (moved) return;
    let best = null, bd = 34;
    for (const h of ar.hits) {
      const d = Math.hypot(h.x - e.clientX, h.y - e.clientY) - (h.star ? 0 : 8);
      if (d < bd) { bd = d; best = h; }
    }
    app.select(best ? best.key : null);
    info();
  });

  // для проверок: window.SkyAR.state
  window.SkyAR = { state: ar, toScreen, centerLook };
})();
