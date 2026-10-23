// ===== «Глаза» и интерфейс: купол неба, перемотка времени, карточки =====
(function () {
  const PLACES = [
    { name: 'Нетания', lat: 32.33, lon: 34.86 },
    { name: 'Мицпе-Рамон', lat: 30.61, lon: 34.80 },
    { name: 'Порту', lat: 41.15, lon: -8.61 },
    { name: 'Москва', lat: 55.76, lon: 37.62 },
  ];

  const BLURBS = {
    sun: 'Звезда, вокруг которой летает Земля. Его дорога по небу называется эклиптикой (пунктир на карте). По этой же дороге ходят Луна и все планеты, потому что орбиты почти лежат в одной плоскости.',
    moon: 'Освещённая сторона всегда смотрит на Солнце. Фаза — это просто угол, под которым мы видим освещённую половину шара. Луна так близко, что приложение поправляет её положение на ~1° под твоё место на Земле.',
    mercury: 'Ближайшая к Солнцу планета. Никогда не отходит от Солнца дальше чем на 28°, поэтому виден только низко над горизонтом в сумерках, и то недолго.',
    venus: 'Ярче неё на ночном небе только Луна: облака из серной кислоты отражают около трёх четвертей солнечного света. Отходит от Солнца не больше чем на 47°, поэтому её зовут то Вечерней, то Утренней звездой.',
    mars: 'Красный из-за ржавчины: пыль на поверхности богата оксидом железа. Раз в два с лишним года Земля обгоняет Марс по орбите, и он становится особенно ярким.',
    jupiter: 'Самая большая планета. В обычный бинокль видны четыре его спутника, которые Галилей открыл в 1610 году. Их расположение меняется от ночи к ночи.',
    saturn: 'Кольца из льда и камней шириной в сотни тысяч километров, а толщиной местами всего десятки метров. Видны даже в небольшой телескоп.',
  };

  // Слои: что показывать на куполе и в камере. Выбор запоминается.
  const LAYERS = [
    ['stars', 'Звёзды', true], ['lines', 'Созвездия', true], ['ecliptic', 'Эклиптика', true],
    ['planets', 'Планеты', true], ['moon', 'Луна', true], ['sun', 'Солнце', true],
    ['featured', 'МКС, Тяньгун, Хаббл', true], ['bright', 'Яркие спутники', true],
    ['starlink', 'Starlink', false], ['planes', 'Самолёты', true],
  ];

  const $ = s => document.querySelector(s);
  const canvas = $('#dome'), ctx = canvas.getContext('2d');
  const box = $('#domeBox');
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem('skyradar.' + k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem('skyradar.' + k, JSON.stringify(v)); } catch (e) { /* не страшно */ } },
  };

  const state = {
    place: store.get('place') || PLACES[0],
    offsetMin: 0,
    playing: null,
    selected: null,     // { kind, key }
    snap: null,
    hits: [],
    sats: [],           // МКС, Тяньгун, Хаббл и ~150 самых ярких спутников
    starlink: [],       // грузим, только если включили
    satView: [],        // кто сейчас над горизонтом
    passes: [],
    tle: null,          // когда и откуда пришли орбиты
    planes: { list: [], view: [], src: '', receivedMs: 0, error: '', busy: false,
      proxy: PLANES_PROXY || store.get('planesProxy') || '' },
    layers: (() => {
      const saved = store.get('layers') || {
        // переезд со старых отдельных переключателей
        bright: store.get('satBright') !== false, starlink: store.get('satStarlink') === true, planes: store.get('planes') !== false,
      };
      return Object.fromEntries(LAYERS.map(([k, , def]) => [k, saved[k] ?? def]));
    })(),
  };
  const L = state.layers;

  const fmt = (x, d = 0) => x.toLocaleString('ru-RU', { maximumFractionDigits: d, minimumFractionDigits: d });
  const hhmm = ms => new Date(ms).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const nowMs = () => Date.now() + state.offsetMin * 60000;
  const coordLine = p => `${fmt(Math.abs(p.lat), 2)}° ${p.lat >= 0 ? 'с.ш.' : 'ю.ш.'}, ${fmt(Math.abs(p.lon), 2)}° ${p.lon >= 0 ? 'в.д.' : 'з.д.'}`;

  // ---------- геометрия купола ----------
  let size = 600, cx = 300, cy = 300, R = 270;
  function resize() {
    const w = box.clientWidth;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    size = w;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(w * dpr);
    canvas.style.width = w + 'px'; canvas.style.height = w + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cx = w / 2; cy = w / 2; R = w / 2 - Math.max(22, w * 0.055);
    render();
  }
  // Зенит в центре, горизонт по краю. Восток слева: так выглядит небо, если лечь головой на север.
  function project(alt, az) {
    const r = R * (90 - alt) / 90, a = az * Math.PI / 180;
    return [cx - r * Math.sin(a), cy - r * Math.cos(a)];
  }

  function skyState(sunAlt) {
    if (sunAlt > 0) return 'День';
    if (sunAlt > -6) return 'Гражданские сумерки';
    if (sunAlt > -12) return 'Навигационные сумерки';
    if (sunAlt > -18) return 'Астрономические сумерки';
    return 'Ночь';
  }
  function mix(a, b, t) { return a.map((v, i) => Math.round(v + (b[i] - v) * t)); }
  function domeColors(sunAlt) {
    const night = [[5, 9, 20], [10, 17, 34]], twi = [[22, 36, 70], [64, 66, 96]], day = [[46, 92, 150], [120, 160, 205]];
    let c;
    if (sunAlt <= -18) c = night;
    else if (sunAlt <= -4) { const t = (sunAlt + 18) / 14; c = [mix(night[0], twi[0], t), mix(night[1], twi[1], t)]; }
    else if (sunAlt <= 4) { const t = (sunAlt + 4) / 8; c = [mix(twi[0], day[0], t), mix(twi[1], day[1], t)]; }
    else c = day;
    return c.map(v => `rgb(${v.join(',')})`);
  }

  // ---------- рисование ----------
  function render() {
    const p = state.place;
    const snap = state.snap = skySnapshot(nowMs(), p.lat, p.lon, STARS);
    const sunAlt = snap.sun.alt;
    const hits = state.hits = [];
    ctx.clearRect(0, 0, size, size);

    // небо
    const [zen, hor] = domeColors(sunAlt);
    const g = ctx.createRadialGradient(cx, cy, R * 0.05, cx, cy, R);
    g.addColorStop(0, zen); g.addColorStop(1, hor);
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();

    // сетка высот и азимутов
    ctx.strokeStyle = 'rgba(160,190,240,0.16)'; ctx.lineWidth = 1;
    for (const a of [30, 60]) { ctx.beginPath(); ctx.arc(cx, cy, R * (90 - a) / 90, 0, Math.PI * 2); ctx.stroke(); }
    for (let az = 0; az < 360; az += 45) {
      const [x, y] = project(0, az); ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x, y); ctx.stroke();
    }
    ctx.fillStyle = 'rgba(160,190,240,0.45)'; ctx.font = `${Math.max(9, size * 0.017)}px "JetBrains Mono", monospace`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    for (const a of [30, 60]) { const [x, y] = project(a, 180); ctx.fillText(a + '°', x + 4, y - 7); }

    // горизонт и деления по кругу
    ctx.strokeStyle = 'rgba(200,220,255,0.55)'; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
    for (let az = 0; az < 360; az += 10) {
      const a = az * Math.PI / 180, l = az % 30 === 0 ? 7 : 4;
      ctx.beginPath();
      ctx.moveTo(cx - R * Math.sin(a), cy - R * Math.cos(a));
      ctx.lineTo(cx - (R + l) * Math.sin(a), cy - (R + l) * Math.cos(a));
      ctx.stroke();
    }
    ctx.fillStyle = '#e6ecf7'; ctx.textAlign = 'center';
    ctx.font = `600 ${Math.max(12, size * 0.032)}px "Jura", sans-serif`;
    const lab = R + Math.max(14, size * 0.03);
    [['С', 0], ['В', 90], ['Ю', 180], ['З', 270]].forEach(([t, az]) => {
      const a = az * Math.PI / 180; ctx.fillText(t, cx - lab * Math.sin(a), cy - lab * Math.cos(a));
    });

    ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();

    // эклиптика
    if (L.ecliptic) {
    ctx.setLineDash([4, 5]); ctx.strokeStyle = 'rgba(243,212,139,0.45)'; ctx.lineWidth = 1;
    const ecl = snap.ecliptic.concat([snap.ecliptic[0]]);
    ctx.beginPath(); let pen = false;
    for (const pt of ecl) {
      if (pt.alt < -2) { pen = false; continue; }
      const [x, y] = project(pt.alt, pt.az);
      if (!pen) { ctx.moveTo(x, y); pen = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke(); ctx.setLineDash([]);
    }

    // звёзды и фигуры созвездий
    const starAlpha = sunAlt > 0 ? 0.22 : sunAlt > -6 ? 0.45 : sunAlt > -12 ? 0.75 : 1;
    const byName = {}; snap.stars.forEach(s => { byName[s.n] = s; });
    ctx.strokeStyle = `rgba(124,196,255,${0.28 * starAlpha})`; ctx.lineWidth = 1;
    for (const [a, b] of L.lines ? CONSTELLATION_LINES : []) {
      const s1 = byName[a], s2 = byName[b];
      if (!s1 || !s2 || s1.alt < 0 || s2.alt < 0) continue;
      const [x1, y1] = project(s1.alt, s1.az), [x2, y2] = project(s2.alt, s2.az);
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    }
    ctx.font = `${Math.max(9, size * 0.019)}px "Golos Text", sans-serif`; ctx.textAlign = 'left';
    for (const s of L.stars ? snap.stars : []) {
      if (s.alt < 0) continue;
      const [x, y] = project(s.alt, s.az);
      const r = Math.max(0.9, (3.4 - 0.78 * s.m) * size / 620);
      ctx.fillStyle = `rgba(235,242,255,${starAlpha})`;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      const isSel = state.selected && state.selected.key === 's:' + s.n;
      if (s.m < 1.6 || isSel || s.n === 'Полярная') {
        ctx.fillStyle = `rgba(200,215,240,${0.85 * Math.max(starAlpha, 0.5)})`;
        ctx.fillText(s.n, x + r + 3, y);
      }
      hits.push({ x, y, key: 's:' + s.n, obj: s, kind: 'star' });
    }

    drawSats(sunAlt, hits);

    // планеты
    ctx.font = `600 ${Math.max(10, size * 0.021)}px "Golos Text", sans-serif`;
    for (const pl of L.planets ? snap.planets : []) {
      if (pl.alt < 0) continue;
      const [x, y] = project(pl.alt, pl.az);
      const r = Math.max(2.4, (3.6 - 0.55 * pl.mag) * size / 620);
      ctx.fillStyle = '#f3d48b'; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(243,212,139,0.35)'; ctx.beginPath(); ctx.arc(x, y, r + 3, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#f3d48b'; ctx.fillText(pl.name, x + r + 5, y);
      hits.push({ x, y, key: 'p:' + pl.id, obj: pl, kind: 'planet' });
    }

    drawPlanes(hits);

    // Солнце
    if (L.sun && snap.sun.alt > -1) {
      const [x, y] = project(Math.max(snap.sun.alt, 0), snap.sun.az);
      const r = Math.max(7, size * 0.016);
      ctx.strokeStyle = '#ffc24a'; ctx.lineWidth = 1.6;
      for (let k = 0; k < 8; k++) {
        const a = k * Math.PI / 4; ctx.beginPath();
        ctx.moveTo(x + Math.cos(a) * (r + 3), y + Math.sin(a) * (r + 3));
        ctx.lineTo(x + Math.cos(a) * (r + 8), y + Math.sin(a) * (r + 8)); ctx.stroke();
      }
      ctx.fillStyle = '#ffc24a'; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      hits.push({ x, y, key: 'sun', obj: snap.sun, kind: 'sun' });
    }

    // Луна с фазой: освещённый край смотрит в сторону Солнца
    if (L.moon && snap.moon.alt > -1) {
      const [x, y] = project(Math.max(snap.moon.alt, 0), snap.moon.az);
      const [sx, sy] = project(snap.sun.alt, snap.sun.az);
      drawMoon(x, y, Math.max(8, size * 0.019), snap.moon, Math.atan2(sy - y, sx - x));
      ctx.fillStyle = '#e9e6da'; ctx.font = `600 ${Math.max(10, size * 0.021)}px "Golos Text", sans-serif`;
      ctx.fillText('Луна', x + Math.max(8, size * 0.019) + 6, y);
      hits.push({ x, y, key: 'moon', obj: snap.moon, kind: 'moon' });
    }

    // выделение
    if (state.selected) {
      const h = hits.find(t => t.key === state.selected.key);
      if (h) {
        ctx.strokeStyle = '#7cc4ff'; ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.arc(h.x, h.y, 14, 0, Math.PI * 2); ctx.stroke();
      }
    }
    ctx.restore();

    // шапка
    $('#clockTime').textContent = hhmm(nowMs());
    $('#skyState').textContent = skyState(sunAlt);
    $('#timeLabel').textContent = timeLabel();
    if (state.selected) fillCard();
  }

  // ---------- спутники ----------
  const SAT_LIT = '#8ef0c4', SAT_DARK = 'rgba(150,165,190,0.55)';
  function drawSats(sunAlt, hits) {
    const p = state.place, t = nowMs();
    const pool = state.sats.filter(s => (s.featured ? L.featured : L.bright));
    // в ускоренном режиме тысячи Starlink не успевают пересчитываться — прячем их
    const withStarlink = L.starlink && !state.playing ? pool.concat(state.starlink) : pool;
    const view = state.satView = satSky(withStarlink, t, p.lat, p.lon);
    const selKey = state.selected && state.selected.key;

    for (const v of view) {
      const s = v.sat, key = 'sat:' + s.id;
      if (s.featured) continue;                        // их рисуем ниже, со следом
      const [x, y] = project(v.alt, v.az);
      const small = s.kind === 'starlink';
      ctx.fillStyle = v.visible ? SAT_LIT : SAT_DARK;
      ctx.globalAlpha = small ? (v.visible ? 0.85 : 0.35) : 1;
      ctx.beginPath(); ctx.arc(x, y, small ? 1.1 : 1.9, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
      if (key === selKey) { ctx.font = `${Math.max(9, size * 0.019)}px "Golos Text", sans-serif`; ctx.fillText(s.name, x + 6, y); }
      hits.push({ x, y, key, obj: v, kind: 'sat' });
    }

    // МКС, Тяньгун, Хаббл: путь на ближайшие минуты, яркий там, где спутник на солнце
    for (const s of L.featured ? state.sats.filter(x => x.featured) : []) {
      const track = satTrack(s, t, p.lat, p.lon);
      ctx.lineWidth = 1.6;
      for (let i = 1; i < track.length; i++) {
        const a = track[i - 1], b = track[i];
        if (a.alt < 0 && b.alt < 0) continue;
        const [x1, y1] = project(Math.max(a.alt, 0), a.az), [x2, y2] = project(Math.max(b.alt, 0), b.az);
        ctx.strokeStyle = b.visible ? 'rgba(142,240,196,0.75)' : 'rgba(150,165,190,0.45)';
        ctx.setLineDash(b.ms <= t ? [2, 3] : []);       // пунктир — где уже пролетел
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      }
      ctx.setLineDash([]);
      const v = view.find(x => x.sat === s);
      if (!v) continue;
      const [x, y] = project(v.alt, v.az);
      ctx.fillStyle = v.visible ? SAT_LIT : '#aab4c8';
      ctx.beginPath(); ctx.arc(x, y, Math.max(3.2, size * 0.0065), 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = v.visible ? 'rgba(142,240,196,0.45)' : 'rgba(170,180,200,0.35)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(x, y, Math.max(3.2, size * 0.0065) + 3.5, 0, Math.PI * 2); ctx.stroke();
      ctx.font = `600 ${Math.max(10, size * 0.021)}px "Golos Text", sans-serif`;
      ctx.fillText(s.name, x + 10, y);
      hits.push({ x, y, key: 'sat:' + s.id, obj: v, kind: 'sat' });
    }
  }

  // ---------- самолёты ----------
  const PLANE_C = '#ff9f7a';
  const planesLive = () => Math.abs(state.offsetMin) <= 2;      // самолёты бывают только «сейчас»
  const planeObs = () => ({ lat: state.place.lat, lon: state.place.lon });
  function drawPlanes(hits) {
    const P = state.planes;
    P.view = [];
    if (!L.planes || !P.list.length || !planesLive()) return;
    const t = nowMs(), obs = planeObs();
    P.view = planeSky(P.list, t, obs);
    ctx.font = `${Math.max(9, size * 0.018)}px "Golos Text", sans-serif`; ctx.textAlign = 'left';
    for (const v of P.view) {
      const pl = v.plane, [x, y] = project(v.alt, v.az);
      // острие смотрит туда, где самолёт будет через 20 секунд
      const ahead = planeAt(pl, t + 20000, obs);
      let ang = -Math.PI / 2;
      if (ahead) { const [x2, y2] = project(Math.max(ahead.alt, 0), ahead.az); if (Math.hypot(x2 - x, y2 - y) > 0.5) ang = Math.atan2(y2 - y, x2 - x); }
      const s = (/A[345]/.test(pl.category) ? 7 : 5.5) * Math.max(1, size / 620);
      ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
      ctx.beginPath(); ctx.moveTo(s, 0); ctx.lineTo(-s * 0.75, s * 0.62); ctx.lineTo(-s * 0.35, 0); ctx.lineTo(-s * 0.75, -s * 0.62); ctx.closePath();
      if (pl.dubious) { ctx.setLineDash([2, 2]); ctx.strokeStyle = PLANE_C; ctx.lineWidth = 1.2; ctx.stroke(); ctx.setLineDash([]); }
      else { ctx.fillStyle = PLANE_C; ctx.fill(); }
      ctx.restore();
      ctx.fillStyle = 'rgba(255,196,172,0.92)';
      ctx.fillText(pl.call || pl.reg || pl.id, x + s + 4, y + s * 0.9);
      hits.push({ x, y, key: 'pl:' + pl.id, obj: v, kind: 'plane' });
    }
  }

  const SOURCE_LINKS = { 'adsb.fi': 'https://adsb.fi', 'airplanes.live': 'https://airplanes.live', 'adsb.one': 'https://adsb.one',
    'adsb.lol': 'https://adsb.lol', opensky: 'https://opensky-network.org' };
  function planesPanel() {
    const P = state.planes, st = $('#planesStatus'), form = $('#proxyForm');
    form.hidden = !!P.proxy && !P.error;
    if (!L.planes) { st.textContent = 'Самолёты выключены в слоях.'; $('#planesList').innerHTML = ''; return; }
    if (!P.proxy) {
      $('#planesList').innerHTML = '';
      st.textContent = 'Самолёты приходят через посредника — маленькую бесплатную программу на Cloudflare (её код в папке worker/). Вставь сюда её адрес.';
      return;
    }
    if (!planesLive()) { $('#planesList').innerHTML = ''; st.textContent = 'Самолёты видны только в режиме «Сейчас»: их будущее никто не знает.'; return; }
    if (P.error && !P.list.length) { $('#planesList').innerHTML = ''; st.textContent = `Посредник не ответил (${P.error}). Пробую каждые 5 секунд; если не пройдёт — проверь адрес.`; return; }
    const near = P.view.slice().sort((a, b) => a.range - b.range).slice(0, 6);
    $('#planesList').innerHTML = near.length ? near.map(v => {
      const pl = v.plane;
      const trend = pl.rate > 400 ? ', набирает высоту' : pl.rate < -400 ? ', снижается' : '';
      return `<li><button class="row" data-key="pl:${pl.id}">
        <span class="row-name">${pl.call || pl.reg || pl.id}${pl.airline ? ` · ${pl.airline}` : ''}</span>
        <span class="row-line">${pl.type || 'тип неизвестен'}. Высота ${fmt(v.h / 1000, 1)} км${trend}, до него ${fmt(v.range)} км. ${fmt(v.alt)}° над горизонтом, ${rumbWord(v.az)}</span></button></li>`;
    }).join('') : '<li class="note">Над горизонтом сейчас самолётов нет.</li>';
    const ago = Math.round((Date.now() - P.receivedMs) / 1000);
    const link = SOURCE_LINKS[P.src];
    st.innerHTML = `Данные: ${link ? `<a href="${link}" target="_blank" rel="noopener">${P.src}</a>` : 'ADS-B'}, ${ago} с назад. `
      + `В радиусе ~110 км: ${P.list.filter(x => !x.onGround).length}, над горизонтом: ${P.view.length}.`
      + (P.error ? ' Последний запрос не прошёл, показываю прошлые данные.' : '');
  }

  async function pollPlanes() {
    const P = state.planes;
    if (!L.planes || !P.proxy || P.busy || document.hidden || !planesLive()) return;
    P.busy = true;
    try {
      const r = await fetchPlanes(P.proxy, state.place.lat, state.place.lon);
      P.list = r.planes; P.src = r.src; P.receivedMs = r.receivedMs; P.error = '';
    } catch (e) {
      P.error = e.name === 'TimeoutError' ? 'нет ответа' : e.message;
      if (Date.now() - P.receivedMs > PLANE_MAX_AGE * 1000) P.list = [];
    }
    P.busy = false;
    render(); planesPanel();
  }

  function drawMoon(x, y, r, moon, sunAngle) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(sunAngle);
    ctx.fillStyle = '#2b2f3a'; ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
    const i = 180 - moon.elong;                       // фазовый угол
    const rx = r * Math.cos(i * Math.PI / 180);
    ctx.fillStyle = '#ece8da'; ctx.beginPath();
    ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2, false);   // освещённая полусфера (к Солнцу)
    if (rx >= 0) ctx.ellipse(0, 0, rx, r, 0, Math.PI / 2, Math.PI * 1.5, false);
    else ctx.ellipse(0, 0, -rx, r, 0, Math.PI / 2, -Math.PI / 2, true);
    ctx.fill(); ctx.restore();
  }

  // ---------- карточка объекта ----------
  function findSelected() {
    const s = state.snap, sel = state.selected;
    if (!s || !sel) return null;
    if (sel.key === 'sun') return { kind: 'sun', obj: s.sun };
    if (sel.key === 'moon') return { kind: 'moon', obj: s.moon };
    if (sel.key.startsWith('p:')) return { kind: 'planet', obj: s.planets.find(p => 'p:' + p.id === sel.key) };
    if (sel.key.startsWith('s:')) return { kind: 'star', obj: s.stars.find(t => 's:' + t.n === sel.key) };
    if (sel.key.startsWith('pl:')) {
      const pl = state.planes.list.find(x => 'pl:' + x.id === sel.key);
      const l = pl && planesLive() && planeAt(pl, nowMs(), planeObs());
      return { kind: 'plane', obj: l && { ...l, plane: pl, name: pl.call || pl.reg || pl.id } };
    }
    if (sel.key.startsWith('sat:')) {
      const id = sel.key.slice(4), sat = state.sats.find(x => x.id === id) || state.starlink.find(x => x.id === id);
      if (!sat) return null;
      const l = satLook(sat, satFrame(nowMs(), state.place.lat, state.place.lon));
      return { kind: 'sat', obj: l && { ...l, sat, name: sat.name } };
    }
    return null;
  }
  function lightTime(sec) {
    if (sec < 60) return fmt(sec, 1) + ' с';
    const m = Math.round(sec / 60);
    return m < 60 ? m + ' мин' : Math.floor(m / 60) + ' ч ' + (m % 60) + ' мин';
  }
  function fillCard() {
    const f = findSelected();
    if (!f || !f.obj) { if (state.selected.key.startsWith('pl:')) $('#card').hidden = true; return; }
    const o = f.obj, card = $('#card');
    const where = o.alt >= 0
      ? f.kind === 'sat' || f.kind === 'plane' ? `${fmt(o.alt)}° над горизонтом, ${rumbWord(o.az)} (азимут ${fmt(o.az)}°)` : `Высота ${fmt(o.alt)}°, ${rumbWord(o.az)} (азимут ${fmt(o.az)}°)`
      : `Сейчас под горизонтом (${fmt(o.alt)}°)`;
    let kind = '', facts = [], text = '';
    if (f.kind === 'sun') {
      kind = 'Наша звезда'; text = BLURBS.sun;
      facts.push(['Расстояние', `${fmt(o.r * 149.6, 1)} млн км`], ['Свет идёт', lightTime(o.r * 499)]);
    } else if (f.kind === 'moon') {
      kind = 'Спутник Земли'; text = BLURBS.moon;
      facts.push(['Фаза', `${fmt(o.illum * 100)}% освещено, ${o.waxing ? 'растёт' : 'убывает'}`],
        ['Расстояние', `${fmt(o.distKm)} км`], ['Свет идёт', lightTime(o.distKm / 299792)]);
    } else if (f.kind === 'planet') {
      kind = 'Планета'; text = BLURBS[o.id];
      facts.push(['Звёздная величина', fmt(o.mag, 1)],
        ['Расстояние', o.distAU * 149.6 >= 1000 ? `${fmt(o.distAU * 0.1496, 2)} млрд км` : `${fmt(o.distAU * 149.6)} млн км`],
        ['Свет идёт', lightTime(o.distAU * 499)], ['От Солнца на небе', `${fmt(o.elong)}°`]);
      if (o.elong < 15) text += ' Сейчас она слишком близко к Солнцу и тонет в его лучах.';
    } else if (f.kind === 'plane') {
      const pl = o.plane;
      kind = pl.category === 'A7' ? 'Вертолёт' : 'Самолёт';
      if (pl.airline) facts.push(['Авиакомпания', pl.airline]);
      if (pl.type) facts.push(['Тип', pl.type + (pl.reg ? `, борт ${pl.reg}` : '')]);
      const trend = pl.rate > 400 ? ' и набирает' : pl.rate < -400 ? ' и снижается' : '';
      facts.push(['Высота полёта', `${fmt(o.h)} м${trend}`], ['Скорость', `${fmt(pl.gs * 1.852)} км/ч`],
        ['До него', `${fmt(o.range, 1)} км`]);
      if (pl.track != null) facts.push(['Летит на', rumbWord(pl.track)]);
      facts.push(['Данные', `${fmt(Math.max(0, o.age))} с назад${pl.mlat ? ', место вычислено по времени прихода сигнала (MLAT)' : ''}`]);
      text = 'Самолёт сам каждые полсекунды сообщает в эфир, кто он, где и на какой высоте (ADS-B). Эти сообщения ловят тысячи любительских антенн и складывают в общую карту. '
        + 'Между обновлениями приложение двигает самолёт по его скорости и курсу — «упреждение», как у зенитчика.';
      if (pl.dubious) text += ' Позиция под сомнением: похоже на помехи GPS. Над Израилем GPS часто глушат и подменяют, и самолёты на картах «прыгают» — сам самолёт летит ровно, врёт только его приёмник.';
      if (pl.emergency && pl.emergency !== 'none') text += ' Экипаж передаёт сигнал тревоги.';
    } else if (f.kind === 'sat') {
      const s = o.sat, info = SAT_INFO[s.id];
      kind = info ? info.kind : { starlink: 'Спутник Starlink', rocket: 'Ступень ракеты', debris: 'Обломок', generic: 'Спутник' }[s.kind];
      text = info ? info.blurb : SAT_BLURB[s.kind];
      const dark = state.snap.sun.alt < -6;
      const light = !o.sunlit ? 'в тени Земли: не светится, глазом не видно'
        : dark ? 'на солнце, а у тебя темно — виден глазом' : 'на солнце, но у тебя слишком светло';
      facts.push(['Сейчас', light]);
      if (o.sunlit && o.alt > 0) facts.push(['Яркость', `≈ ${fmt(o.mag, 1)}`]);
      facts.push(['Высота орбиты', `${fmt(o.height)} км`], ['До тебя', `${fmt(o.range)} км`],
        ['Скорость', `${fmt(o.speed * 3600)} км/ч, виток за ${fmt(2 * Math.PI / s.satrec.no)} мин`]);
      const next = state.passes.find(x => x.sat.id === s.id && x.end.ms > nowMs());
      if (s.featured) facts.push(['Видимый пролёт', next ? passWhen(next) : 'в ближайшие сутки нет']);
      const ageH = (Date.now() - s.epochMs) / 3600e3;
      facts.push(['Данные орбиты', ageH < 48 ? `${fmt(ageH)} ч назад` : `${fmt(ageH / 24)} дн. назад`]);
    } else {
      kind = `Звезда · ${o.c}`;
      const year = new Date().getFullYear() - Math.round(o.ly);
      text = o.n === 'Полярная'
        ? 'Почти точно над северным полюсом мира, поэтому всё небо вращается вокруг неё. Её высота над горизонтом равна твоей широте: по ней веками определяли, где ты на Земле.'
        : (o.note || 'Далёкое солнце. Чем меньше звёздная величина, тем ярче звезда: разница в 5 ступеней означает яркость в 100 раз.');
      facts.push(['Звёздная величина', fmt(o.m, 2)],
        ['Свет шёл к тебе', o.ly < 1500 ? `~${fmt(o.ly, o.ly < 20 ? 1 : 0)} лет: ты видишь её такой, какой она была примерно в ${year} году` : `~${fmt(o.ly)} лет`]);
    }
    card.querySelector('.card-kind').textContent = kind;
    card.querySelector('.card-name').textContent = o.name || o.n;
    card.querySelector('.card-where').textContent = where;
    // термины — ссылки в словарик; перерисовываем только если текст изменился, чтобы не сбивать нажатие
    const setHtml = (el, html) => { if (el._html !== html) { el._html = html; el.innerHTML = html; } };
    setHtml(card.querySelector('.card-facts'), facts.map(([k, v]) => `<div><dt>${linkTerms(k)}</dt><dd>${v}</dd></div>`).join(''));
    setHtml(card.querySelector('.card-text'), linkTerms(text));
    card.hidden = false;
  }
  function select(key) {
    state.selected = key ? { key } : null;
    if (!key) $('#card').hidden = true;
    render();
  }

  canvas.addEventListener('click', e => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    let best = null, bd = 26;
    for (const h of state.hits) {
      const d = Math.hypot(h.x - x, h.y - y);
      const bonus = h.kind === 'star' ? 0 : 6;       // планеты и Луну легче попасть пальцем
      if (d - bonus < bd) { bd = d - bonus; best = h; }
    }
    select(best ? best.key : null);
  });
  $('#cardClose').addEventListener('click', () => select(null));

  // ---------- время ----------
  function timeLabel() {
    const m = state.offsetMin;
    if (m === 0) return 'Сейчас';
    const sign = m > 0 ? '+' : '−', a = Math.abs(m);
    const h = Math.floor(a / 60), mm = a % 60;
    return `${sign}${h ? h + ' ч ' : ''}${mm ? mm + ' мин' : ''}`.trim();
  }
  const range = $('#timeRange');
  range.addEventListener('input', () => { stopPlay(); state.offsetMin = +range.value; render(); updateNowList(); planesPanel(); });
  $('#btnNow').addEventListener('click', () => { stopPlay(); state.offsetMin = 0; range.value = 0; render(); updateNowList(); planesPanel(); pollPlanes(); });
  function stopPlay() {
    if (state.playing) { clearInterval(state.playing); state.playing = null; $('#btnPlay').textContent = 'Ускорить ×3600'; $('#btnPlay').setAttribute('aria-pressed', 'false'); }
  }
  $('#btnPlay').addEventListener('click', () => {
    if (state.playing) return stopPlay();
    $('#btnPlay').textContent = 'Стоп'; $('#btnPlay').setAttribute('aria-pressed', 'true');
    state.playing = setInterval(() => {
      state.offsetMin += 3;                            // 3 минуты неба за 50 мс = час в секунду
      if (state.offsetMin > +range.max) state.offsetMin = +range.min;
      range.value = state.offsetMin; render();
    }, 50);
  });

  // ---------- панель: сегодня, ночь, сейчас ----------
  function altOf(kind, id, ms) {
    const p = state.place, s = skySnapshot(ms, p.lat, p.lon, null);
    if (kind === 'moon') return s.moon.alt;
    return s.planets.find(x => x.id === id).alt;
  }
  function updateToday() {
    const p = state.place, base = Date.now();
    const sunFn = t => sunAltAt(t, p.lat, p.lon);
    const from = base - 12 * 3600e3, to = base + 36 * 3600e3;
    const rs = findCrossings(sunFn, from, to, -0.833, 6);
    const dusk = findCrossings(sunFn, from, to, -18, 6);
    const isNight = sunFn(base) < -0.833;
    // ночью «эта ночь» уже идёт: от последнего заката до ближайшего восхода
    const lastSet = [...rs].reverse().find(x => !x.rising && x.ms <= base);
    const set = isNight ? lastSet : rs.find(x => !x.rising && x.ms > base);
    const rise = rs.find(x => x.rising && x.ms > (isNight ? base : (set ? set.ms : base)));
    const darkStart = set && dusk.find(x => !x.rising && x.ms > set.ms);
    const moon = skySnapshot(base, p.lat, p.lon, null).moon;
    const rows = [
      ['Закат', set ? (isNight ? 'был в ' : '') + hhmm(set.ms) : '—'],
      ['Полная темнота', darkStart ? 'с ' + hhmm(darkStart.ms) : '—'],
      ['Восход', rise ? hhmm(rise.ms) : '—'],
      ['Луна', `${fmt(moon.illum * 100)}%, ${moon.waxing ? 'растёт' : 'убывает'}`],
    ];
    $('#today').innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
    const nightFrom = isNight ? base : (set ? set.ms : base);
    return { nightFrom, nightTo: rise ? rise.ms : nightFrom + 10 * 3600e3 };
  }

  function updateTonight(win) {
    const p = state.place, items = [];
    const objs = [{ kind: 'moon', id: 'moon', name: 'Луна', key: 'moon' }]
      .concat(PLANETS.map(x => ({ kind: 'planet', id: x.id, name: x.name, key: 'p:' + x.id })));
    const sun = skySnapshot(win.nightFrom, p.lat, p.lon, null);
    for (const o of objs) {
      let best = -90, bestMs = 0, firstUp = null, lastUp = null;
      for (let t = win.nightFrom; t <= win.nightTo; t += 10 * 60000) {
        const a = altOf(o.kind, o.id, t);
        if (a > best) { best = a; bestMs = t; }
        if (a > 10) { if (firstUp === null) firstUp = t; lastUp = t; }
      }
      const planet = o.kind === 'planet' ? sun.planets.find(x => x.id === o.id) : null;
      if (planet && planet.elong < 15) { items.push({ o, line: 'Тонет в лучах Солнца, не увидеть', dim: true }); continue; }
      if (best < 10) { items.push({ o, line: 'Этой ночью низко или под горизонтом', dim: true }); continue; }
      const startsEdge = firstUp - win.nightFrom < 20 * 60000, endsEdge = win.nightTo - lastUp < 20 * 60000;
      const span = startsEdge && endsEdge ? 'всю ночь' : startsEdge ? `вечером, до ${hhmm(lastUp)}` : endsEdge ? `с ${hhmm(firstUp)} до утра` : `с ${hhmm(firstUp)} до ${hhmm(lastUp)}`;
      const bestAz = (o.kind === 'moon' ? skySnapshot(bestMs, p.lat, p.lon, null).moon : skySnapshot(bestMs, p.lat, p.lon, null).planets.find(x => x.id === o.id)).az;
      items.push({ o, line: `Видно ${span}. Выше всего в ${hhmm(bestMs)}: ${fmt(best)}°, ${rumbWord(bestAz)}`, mag: planet ? planet.mag : null });
    }
    $('#tonight').innerHTML = items.map(it => `
      <li><button class="row${it.dim ? ' dim' : ''}" data-key="${it.o.key}">
        <span class="row-name">${it.o.name}${it.mag != null ? `<span class="mag">${fmt(it.mag, 1)}</span>` : ''}</span>
        <span class="row-line">${it.line}</span></button></li>`).join('');
  }

  function updateNowList() {
    const s = state.snap; if (!s) return;
    const all = [];
    if (L.sun && s.sun.alt > 0) all.push({ key: 'sun', name: 'Солнце', mag: -26.7, alt: s.sun.alt, az: s.sun.az });
    if (L.moon && s.moon.alt > 0) all.push({ key: 'moon', name: 'Луна', mag: s.moon.mag, alt: s.moon.alt, az: s.moon.az });
    if (L.planets) s.planets.forEach(p => { if (p.alt > 3 && p.elong > 12) all.push({ key: 'p:' + p.id, name: p.name, mag: p.mag, alt: p.alt, az: p.az }); });
    if (L.stars) s.stars.forEach(t => { if (t.alt > 5) all.push({ key: 's:' + t.n, name: t.n, mag: t.m, alt: t.alt, az: t.az }); });
    state.satView.forEach(v => { if (v.sat.featured && v.visible) all.push({ key: 'sat:' + v.sat.id, name: v.sat.name, mag: v.mag, alt: v.alt, az: v.az }); });
    all.sort((a, b) => a.mag - b.mag);
    $('#nowTitle').textContent = state.offsetMin === 0 ? 'Самое яркое сейчас' : `Самое яркое в ${hhmm(nowMs())}`;
    $('#nowList').innerHTML = all.slice(0, 8).map(o => `
      <li><button class="row" data-key="${o.key}">
        <span class="row-name">${o.name}<span class="mag">${fmt(o.mag, 1)}</span></span>
        <span class="row-line">${fmt(o.alt)}° над горизонтом, ${rumbWord(o.az)}</span></button></li>`).join('');
  }

  document.addEventListener('click', e => {
    const b = e.target.closest('button.row'); if (!b) return;
    if (b.dataset.jump) {
      stopPlay();
      state.offsetMin = Math.round((+b.dataset.jump - Date.now()) / 60000);
      range.value = state.offsetMin;
    }
    select(b.dataset.key);
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  // ---------- место ----------
  function applyPlace(pl) {
    state.place = pl; store.set('place', pl);
    $('#placeLine').textContent = `${pl.name} · ${coordLine(pl)}`;
    $('#lat').value = pl.lat; $('#lon').value = pl.lon;
    document.querySelectorAll('.preset').forEach(b => b.setAttribute('aria-pressed', b.dataset.name === pl.name ? 'true' : 'false'));
    state.planes.list = []; state.planes.receivedMs = 0;
    render(); refreshPanel(); pollPlanes();
  }
  $('#presets').innerHTML = PLACES.map(pl => `<button class="preset" data-name="${pl.name}" aria-pressed="false">${pl.name}</button>`).join('');
  $('#presets').addEventListener('click', e => {
    const b = e.target.closest('.preset'); if (!b) return;
    applyPlace(PLACES.find(p => p.name === b.dataset.name));
  });
  $('#placeForm').addEventListener('submit', e => {
    e.preventDefault();
    const lat = parseFloat(String($('#lat').value).replace(',', '.')), lon = parseFloat(String($('#lon').value).replace(',', '.'));
    if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) { $('#placeMsg').textContent = 'Широта от −90 до 90, долгота от −180 до 180.'; return; }
    $('#placeMsg').textContent = '';
    applyPlace({ name: 'Моё место', lat, lon });
  });
  $('#btnGeo').addEventListener('click', () => {
    if (!navigator.geolocation) { $('#placeMsg').textContent = 'Браузер не умеет определять место. Введи координаты вручную.'; return; }
    $('#placeMsg').textContent = 'Определяю…';
    navigator.geolocation.getCurrentPosition(
      pos => { $('#placeMsg').textContent = ''; applyPlace({ name: 'Моё место', lat: +pos.coords.latitude.toFixed(3), lon: +pos.coords.longitude.toFixed(3) }); },
      () => { $('#placeMsg').textContent = 'Здесь геолокация недоступна. Введи координаты вручную или выбери город.'; },
      { timeout: 8000 });
  });

  // ---------- спутники: загрузка орбит и пролёты ----------
  const dayWord = ms => {
    const d = new Date(ms), today = new Date(), tm = new Date(Date.now() + 86400e3);
    return d.toDateString() === today.toDateString() ? 'сегодня' : d.toDateString() === tm.toDateString() ? 'завтра' : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  };
  const DIR8 = ['север', 'северо-восток', 'восток', 'юго-восток', 'юг', 'юго-запад', 'запад', 'северо-запад'];
  const dir8 = az => DIR8[Math.floor(((az % 360) + 382.5) / 45) % 8];
  const passWhen = ps => `${dayWord(ps.start.ms)} ${hhmm(ps.start.ms)}–${hhmm(ps.end.ms)}`;

  function updatePasses() {
    const p = state.place, from = Date.now() - 15 * 60000;
    if (!state.sats.length) return;
    state.passes = state.sats.filter(s => s.featured)
      .flatMap(s => satPasses(s, from, 24, p.lat, p.lon))
      .filter(x => x.end.ms > Date.now())
      .sort((a, b) => a.start.ms - b.start.ms);
    $('#passes').innerHTML = state.passes.length ? state.passes.map(ps => {
      const s = ps.sat;
      let line = `${passWhen(ps)}. Выше всего ${fmt(ps.max.alt)}° на ${dir8(ps.max.az)}е. `
        + `${ps.fromShadow ? 'Вынырнет из тени' : 'Появится'} на ${dir8(ps.start.az)}е, `;
      line += ps.endsInShadow ? `погаснет на ${dir8(ps.end.az)}е: войдёт в тень Земли.` : `уйдёт на ${dir8(ps.end.az)}.`;
      return `<li><button class="row" data-key="sat:${s.id}" data-jump="${ps.max.ms}">
        <span class="row-name">${s.name}<span class="mag">${fmt(ps.mag, 1)}</span></span>
        <span class="row-line">${line}</span></button></li>`;
    }).join('') : '<li class="note">В ближайшие сутки видимых пролётов нет: спутники проходят днём или в тени Земли.</li>';
    if (state.selected) fillCard();
  }

  function satStatus() {
    const tle = state.tle; if (!tle) return;
    const ageMin = Math.round((Date.now() - tle.t) / 60000);
    const age = ageMin < 60 ? `${ageMin} мин назад` : ageMin < 2880 ? `${Math.round(ageMin / 60)} ч назад` : `${Math.round(ageMin / 1440)} дн. назад`;
    let line = `Орбиты: ${tle.source === 'backup' ? 'tle.ivanstanojevic.me (CelesTrak не ответил)' : 'CelesTrak'}, загружены ${age}. Спутников: ${fmt(state.sats.length)}`;
    if (state.starlink.length) line += ` + ${fmt(state.starlink.length)} Starlink`;
    line += '.';
    if (tle.stale) line += ' Сеть недоступна, показываю сохранённые орбиты.';
    if (ageMin > 3 * 1440) line += ' Данные старые: спутник может оказаться в стороне от метки.';
    $('#satStatus').textContent = line;
  }

  async function loadSats() {
    try {
      // «яркие» могут не прийти — тогда хватит и трёх главных
      const [vis, st] = await Promise.all([loadTleGroup('visual').catch(() => null), loadTleGroup('stations')]);
      // из «станций» берём только сами станции: пристыкованные корабли летят там же
      state.sats = mergeSats(parseTle(st.text, 'stations').filter(s => SAT_INFO[s.id]), vis ? parseTle(vis.text, 'visual') : []);
      state.tle = vis || st;
      satStatus(); render(); updatePasses(); updateNowList();
    } catch (e) {
      $('#passes').innerHTML = '<li class="note">Не получилось загрузить орбиты спутников. Нет сети? Попробую ещё раз через минуту.</li>';
      setTimeout(loadSats, 60000);
    }
  }
  async function loadStarlink() {
    $('#satStatus').textContent = 'Загружаю Starlink: это несколько тысяч орбит…';
    try {
      state.starlink = parseTle((await loadTleGroup('starlink')).text, 'starlink');
    } catch (e) {
      state.starlink = [];
      $('#satStatus').textContent = 'Starlink не загрузился. Попробуй позже.';
      return;
    }
    satStatus(); render();
  }
  $('#proxyUrl').value = state.planes.proxy;
  $('#proxyForm').addEventListener('submit', e => {
    e.preventDefault();
    const v = $('#proxyUrl').value.trim();
    if (v && !/^(https:\/\/|http:\/\/localhost)\S+$/.test(v)) { $('#planesStatus').textContent = 'Адрес должен начинаться с https://'; return; }
    state.planes.proxy = v; state.planes.error = ''; store.set('planesProxy', v);
    planesPanel(); pollPlanes();
  });
  // Слои: одни и те же кнопки под куполом и в режиме камеры
  function renderLayers() {
    const html = LAYERS.map(([k, name]) => `<button class="chip" data-layer="${k}" aria-pressed="${L[k]}">${name}</button>`).join('');
    document.querySelectorAll('.layers').forEach(el => { el.innerHTML = html; });
  }
  function setLayer(k, on) {
    L[k] = on; store.set('layers', L);
    renderLayers();
    if (k === 'starlink' && on && !state.starlink.length) loadStarlink();
    if (k === 'planes') { planesPanel(); pollPlanes(); }
    render(); updateNowList();
  }
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-layer]'); if (!b) return;
    setLayer(b.dataset.layer, !L[b.dataset.layer]);
  });
  renderLayers();

  function refreshPanel() { const win = updateToday(); updateTonight(win); updateNowList(); updatePasses(); satStatus(); planesPanel(); }

  // ---------- старт ----------
  new ResizeObserver(() => resize()).observe(box);
  applyPlace(state.place);
  setInterval(() => { if (!state.playing) { render(); } }, 1000);
  setInterval(() => { if (!state.playing) updateNowList(); }, 15000);
  setInterval(refreshPanel, 10 * 60000);
  loadSats();
  pollPlanes();
  setInterval(pollPlanes, 5000);                       // самолёты — раз в 5 секунд, между запросами упреждение
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pollPlanes(); });
  if (L.starlink) loadStarlink();
  setInterval(loadSats, 3 * 3600e3);                   // свежие орбиты раз в 3 часа

  // для режима камеры (src/ar.js): те же данные и та же карточка, что у купола
  window.SkyApp = { state, store, select, fmt, goNow: () => $('#btnNow').click() };
})();
