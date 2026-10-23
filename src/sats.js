// ===== Спутники: орбиты (TLE) → место на небе, освещённость, яркость, пролёты =====
// Орбиту описывают две строки цифр (TLE). Модель SGP4 из satellite.js по ним говорит, где спутник
// в любой момент. Дальше всё как у звёзд: азимут и высота над горизонтом.
// Глазом спутник виден, только когда он сам на солнце, а у наблюдателя уже темно («зеркальце на солнце»).

const EARTH_R = 6378.137;                 // км, экваториальный радиус: граница тени Земли
const TWILIGHT_DARK = -6;                 // Солнце ниже −6°: небо достаточно тёмное, чтобы заметить спутник
const PASS_MIN_ALT = 10;                  // ниже 10° пролёт теряется в дымке и за домами

// Свои имена и «стандартная яркость»: звёздная величина на расстоянии 1000 км при половинном освещении
const SAT_INFO = {
  '25544': { name: 'МКС', kind: 'Космическая станция', std: -1.8, featured: true,
    blurb: 'Международная космическая станция: размером с футбольное поле, летит на высоте ~420 км со скоростью 28 000 км/ч и облетает Землю за полтора часа. На борту обычно 7 человек. Ярче неё ночью бывают только Луна и Венера.' },
  '48274': { name: 'Тяньгун', kind: 'Китайская станция', std: -0.8, featured: true,
    blurb: 'Китайская станция «Небесный дворец». Меньше МКС, летит чуть ниже (~390 км), но тоже хорошо видна глазом. Орбита наклонена на 41,5°, поэтому из Израиля пролёты бывают часто.' },
  '20580': { name: 'Хаббл', kind: 'Космический телескоп', std: 2.2, featured: true,
    blurb: 'Телескоп размером с автобус на высоте ~520 км, работает с 1990 года. Орбита наклонена всего на 28,5°, поэтому из северных широт он виден только низко на юге. Глазом заметен как ровная звёздочка средней яркости.' },
};
const SAT_BLURB = {
  rocket: 'Отработавшая верхняя ступень ракеты: пустой бак размером с автобус. Именно такие «бочки» дают большую часть ярких спутников в списке: они крупные и хорошо отражают свет.',
  debris: 'Обломок: кусок старого спутника или ракеты. Их на орбите десятки тысяч, видны глазом единицы.',
  starlink: 'Спутник интернета Starlink, плоская панель размером с кухонный стол на высоте ~550 км. Их больше 8 000. Сразу после запуска летят цепочкой («поезд»), потом расходятся по своим орбитам.',
  generic: 'Спутник сам не светится: это зеркальце на солнце. Его видно в сумерках и первые часы ночи: у тебя уже темно, а на высоте сотен километров ещё светит Солнце. Ближе к полуночи большинство спутников ныряют в тень Земли и гаснут.',
};

const TLE_GROUPS = {
  visual: { local: 'data/visual.tle', remote: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=visual&FORMAT=tle' },
  // если CelesTrak молчит, три главных спутника берём поштучно из запасного сервиса
  stations: { local: 'data/stations.tle', remote: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle', byId: true },
  starlink: { local: 'data/starlink.tle', remote: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=tle' },
};
const TLE_BACKUP = id => `https://tle.ivanstanojevic.me/api/tle/${id}`;
const TLE_MAX_AGE = 3 * 3600e3;           // свежий кэш не перезапрашиваем: CelesTrak просит не дёргать чаще

function satKind(name) {
  if (/STARLINK/i.test(name)) return 'starlink';
  if (/R\/B|ROCKET/i.test(name)) return 'rocket';
  if (/DEB/i.test(name)) return 'debris';
  return 'generic';
}

// Текст TLE → записи с готовой орбитой. Строка имени необязательна.
function parseTle(text, group) {
  const lines = text.split(/\r?\n/).map(s => s.trimEnd()).filter(Boolean), out = [];
  for (let i = 0; i < lines.length - 1; i++) {
    const l1 = lines[i], l2 = lines[i + 1];
    if (!l1.startsWith('1 ') || !l2.startsWith('2 ')) continue;
    const id = l1.slice(2, 7).trim();
    const prev = i > 0 ? lines[i - 1] : '';
    const raw = prev && !/^[12] /.test(prev) ? prev.trim() : 'NORAD ' + id;
    const satrec = satellite.twoline2satrec(l1, l2);
    i++;
    if (satrec.error) continue;
    const info = SAT_INFO[id] || {};
    const kind = satKind(raw);
    out.push({
      id, raw, group, satrec, kind,
      name: info.name || raw,
      std: info.std != null ? info.std : kind === 'starlink' ? 5 : 4,
      featured: !!info.featured,
      epochMs: (satrec.jdsatepoch - 2440587.5) * 86400e3,
    });
  }
  return out;
}

// Скачать группу: сначала копия на нашем сайте (её раз в 6 часов кладёт GitHub Actions),
// потом напрямую CelesTrak, а если сети нет — что лежит в кэше, даже несвежее.
async function loadTleGroup(group, opts = {}) {
  const key = 'skyradar.tle.' + group, src = TLE_GROUPS[group];
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(key)); } catch (e) { /* нет хранилища */ }
  if (cached && !opts.force && Date.now() - cached.t < TLE_MAX_AGE) return cached;
  const save = (text, source) => {
    const rec = { t: Date.now(), text, source };
    try { localStorage.setItem(key, JSON.stringify(rec)); } catch (e) { /* переполнено — живём без кэша */ }
    return rec;
  };
  for (const url of [src.local, src.remote]) {
    try {
      const res = await fetch(url, { cache: 'no-cache', signal: AbortSignal.timeout(20000) });
      if (!res.ok) continue;
      const text = await res.text();
      if (!/^1 /m.test(text)) continue;              // вместо орбит пришла ошибка
      return save(text, url === src.local ? 'site' : 'celestrak');
    } catch (e) { /* пробуем следующий источник */ }
  }
  if (src.byId) {
    const got = await Promise.all(Object.keys(SAT_INFO).map(async id => {
      try {
        const j = await (await fetch(TLE_BACKUP(id), { signal: AbortSignal.timeout(20000) })).json();
        return j.line1 ? `${j.name}\n${j.line1}\n${j.line2}` : '';
      } catch (e) { return ''; }
    }));
    const text = got.filter(Boolean).join('\n');
    if (text) return save(text, 'backup');
  }
  if (cached) return { ...cached, stale: true };
  throw new Error('Не удалось загрузить орбиты (' + group + ')');
}

// Склеить группы, убрав повторы (МКС есть и в «ярких», и в «станциях»)
function mergeSats(...lists) {
  const seen = new Map();
  for (const l of lists) for (const s of l) if (!seen.has(s.id)) seen.set(s.id, s);
  return [...seen.values()];
}

// Всё, что не зависит от конкретного спутника: Солнце, вращение Земли, где стоит наблюдатель
function satFrame(ms, lat, lon) {
  const date = new Date(ms), gmst = satellite.gstime(date);
  const obs = { latitude: lat * D2R, longitude: lon * D2R, height: 0.05 };
  const sun = sunPosition(julianDate(ms));
  const sunU = [cosd(sun.dec) * cosd(sun.ra), cosd(sun.dec) * sind(sun.ra), sind(sun.dec)];
  return { ms, date, gmst, obs, sunU, obsEci: satellite.ecfToEci(satellite.geodeticToEcf(obs), gmst),
    sunAlt: sunAltAt(ms, lat, lon) };
}

// Звёздная величина: дальше — тусклее; «полная фаза» (солнце за спиной у тебя) — ярче
function satMag(std, rangeKm, phaseDeg) {
  const ph = phaseDeg * D2R;
  const f = (Math.sin(ph) + (Math.PI - ph) * Math.cos(ph)) / Math.PI;     // доля света от шара
  return std + 5 * Math.log10(rangeKm / 1000) - 2.5 * Math.log10(Math.max(f * Math.PI, 1e-3));
}

// Где спутник для наблюдателя в момент frame.ms
function satLook(s, f) {
  const pv = satellite.propagate(s.satrec, f.date);
  if (!pv || !pv.position) return null;              // орбита «развалилась»: слишком старые данные
  const r = pv.position;
  const look = satellite.ecfToLookAngles(f.obs, satellite.eciToEcf(r, f.gmst));
  let alt = look.elevation * R2D;
  alt += refraction(alt);
  // Тень Земли — цилиндр за планетой: спутник в тени, если он «за» Землёй и ближе к оси, чем её радиус
  const dot = r.x * f.sunU[0] + r.y * f.sunU[1] + r.z * f.sunU[2];
  const perp = Math.hypot(r.x - dot * f.sunU[0], r.y - dot * f.sunU[1], r.z - dot * f.sunU[2]);
  const sunlit = dot > 0 || perp > EARTH_R;
  const visible = sunlit && alt > 0 && f.sunAlt < TWILIGHT_DARK;
  let mag = null;
  if (sunlit) {
    const to = [f.obsEci.x - r.x, f.obsEci.y - r.y, f.obsEci.z - r.z], d = Math.hypot(...to);
    const phase = Math.acos(Math.max(-1, Math.min(1, (to[0] * f.sunU[0] + to[1] * f.sunU[1] + to[2] * f.sunU[2]) / d))) * R2D;
    mag = satMag(s.std, look.rangeSat, phase);
  }
  return {
    alt, az: rev(look.azimuth * R2D), range: look.rangeSat, sunlit, visible, mag,
    height: Math.hypot(r.x, r.y, r.z) - EARTH_R,
    speed: Math.hypot(pv.velocity.x, pv.velocity.y, pv.velocity.z),
  };
}

// Положения всех спутников над горизонтом
function satSky(sats, ms, lat, lon) {
  const f = satFrame(ms, lat, lon), out = [];
  for (const s of sats) {
    const l = satLook(s, f);
    if (l && l.alt > 0) out.push({ sat: s, ...l });
  }
  return out;
}

// След на небе: где спутник был и где будет (для МКС и других главных)
function satTrack(s, ms, lat, lon, fromMin = -3, toMin = 6, stepSec = 20) {
  const pts = [];
  for (let t = ms + fromMin * 60e3; t <= ms + toMin * 60e3; t += stepSec * 1000) {
    const l = satLook(s, satFrame(t, lat, lon));
    if (l) pts.push({ ms: t, ...l });
  }
  return pts;
}

// Только высота, без Солнца: дёшево, для грубого поиска
function satAltOnly(s, ms, obs) {
  const d = new Date(ms), pv = satellite.propagate(s.satrec, d);
  if (!pv || !pv.position) return null;
  return satellite.ecfToLookAngles(obs, satellite.eciToEcf(pv.position, satellite.gstime(d))).elevation * R2D;
}

// Видимые пролёты: отрезки, где спутник выше 10°, освещён, а у тебя темно.
// Раз в минуту смотрим, не поднялся ли спутник над горизонтом; если да — разбираем этот кусок подробно.
function satPasses(s, fromMs, hours, lat, lon, stepSec = 10) {
  const out = [], toMs = fromMs + hours * 3600e3, coarse = 60e3;
  const obs = { latitude: lat * D2R, longitude: lon * D2R, height: 0.05 };
  for (let t = fromMs; t <= toMs; t += coarse) {
    const a = satAltOnly(s, t, obs);
    if (a === null || a <= 0) continue;
    // над горизонтом: идём мелким шагом от минуты назад, пока не зайдёт
    let cur = null, prev = null, u = Math.max(fromMs, t - coarse);
    const close = reason => { cur.endsInShadow = reason === 'shadow'; out.push(cur); cur = null; };
    for (; u <= toMs; u += stepSec * 1000) {
      const l = satLook(s, satFrame(u, lat, lon));
      if (!l) break;
      const ok = l.visible && l.alt >= PASS_MIN_ALT;
      if (ok && !cur) {
        cur = { sat: s, start: { ms: u, ...l }, max: { ms: u, ...l }, end: null, mag: l.mag,
          fromShadow: !!(prev && prev.alt >= PASS_MIN_ALT && !prev.sunlit) };
      }
      if (ok) {
        if (l.alt > cur.max.alt) cur.max = { ms: u, ...l };
        if (l.mag < cur.mag) cur.mag = l.mag;
        cur.end = { ms: u, ...l };
      } else if (cur) {
        close(l.alt >= PASS_MIN_ALT && !l.sunlit ? 'shadow' : 'set');
      }
      if (l.alt < 0 && u > t) break;
      prev = l;
    }
    if (cur) close('cut');
    t = u;                                           // дальше грубый поиск с места захода
  }
  return out;
}
