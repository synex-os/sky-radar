// ===== Астрономический «мозг»: всё считается по часам и формулам, без интернета =====
// Алгоритмы низкой точности (П. Шлайтер) — ошибка порядка угловых минут, глазу незаметно.

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const rev = x => ((x % 360) + 360) % 360;
const sind = x => Math.sin(x * D2R), cosd = x => Math.cos(x * D2R);
const atan2d = (y, x) => Math.atan2(y, x) * R2D;
const asind = x => Math.asin(Math.max(-1, Math.min(1, x))) * R2D;

function julianDate(ms) { return ms / 86400000 + 2440587.5; }

// Местное звёздное время: насколько повернулся «небесный глобус» над тобой (в градусах)
function localSiderealDeg(jd, lonDeg) {
  return rev(280.46061837 + 360.98564736629 * (jd - 2451545.0) + lonDeg);
}

function eclToEqu(lon, lat, ecl) {
  const x = cosd(lat) * cosd(lon), y = cosd(lat) * sind(lon), z = sind(lat);
  const ye = y * cosd(ecl) - z * sind(ecl), ze = y * sind(ecl) + z * cosd(ecl);
  return { ra: rev(atan2d(ye, x)), dec: atan2d(ze, Math.hypot(x, ye)) };
}

// Небесные координаты -> азимут/высота (формула астрономического треугольника)
function equToHor(raDeg, decDeg, latDeg, lstDeg) {
  const H = rev(lstDeg - raDeg);
  const alt = asind(sind(latDeg) * sind(decDeg) + cosd(latDeg) * cosd(decDeg) * cosd(H));
  const az = rev(atan2d(-cosd(decDeg) * sind(H),
    sind(decDeg) * cosd(latDeg) - cosd(decDeg) * cosd(H) * sind(latDeg)));
  return { alt, az };
}

// Атмосферная рефракция (формула Беннета): у горизонта поднимает картинку на ~0,5°
function refraction(alt) {
  if (alt < -1.5) return 0;
  return 1.02 / Math.tan((alt + 10.3 / (alt + 5.11)) * D2R) / 60;
}

function kepler(Mdeg, e) {
  let E = Mdeg + R2D * e * sind(Mdeg) * (1 + e * cosd(Mdeg));
  for (let k = 0; k < 8; k++) E -= (E - R2D * e * sind(E) - Mdeg) / (1 - e * cosd(E));
  return E;
}

function sunPosition(jd) {
  const d = jd - 2451543.5;
  const w = 282.9404 + 4.70935e-5 * d, e = 0.016709 - 1.151e-9 * d;
  const M = rev(356.0470 + 0.9856002585 * d), ecl = 23.4393 - 3.563e-7 * d;
  const E = kepler(M, e);
  const xv = cosd(E) - e, yv = Math.sqrt(1 - e * e) * sind(E);
  const r = Math.hypot(xv, yv), lon = rev(atan2d(yv, xv) + w);
  const eq = eclToEqu(lon, 0, ecl);
  return { ra: eq.ra, dec: eq.dec, lon, r, xs: r * cosd(lon), ys: r * sind(lon), M, w, ecl };
}

function moonPosition(jd, sun) {
  const d = jd - 2451543.5;
  const N = rev(125.1228 - 0.0529538083 * d), i = 5.1454, w = rev(318.0634 + 0.1643573223 * d);
  const a = 60.2666, e = 0.0549, M = rev(115.3654 + 13.0649929509 * d);
  const E = kepler(M, e);
  const xv = a * (cosd(E) - e), yv = a * Math.sqrt(1 - e * e) * sind(E);
  let r = Math.hypot(xv, yv);
  const vw = atan2d(yv, xv) + w;
  const xh = r * (cosd(N) * cosd(vw) - sind(N) * sind(vw) * cosd(i));
  const yh = r * (sind(N) * cosd(vw) + cosd(N) * sind(vw) * cosd(i));
  const zh = r * sind(vw) * sind(i);
  let lon = atan2d(yh, xh), lat = atan2d(zh, Math.hypot(xh, yh));
  const Ms = sun.M, Mm = M, Ls = sun.M + sun.w, Lm = M + w + N;
  const D = Lm - Ls, F = Lm - N;
  lon += -1.274 * sind(Mm - 2 * D) + 0.658 * sind(2 * D) - 0.186 * sind(Ms)
    - 0.059 * sind(2 * Mm - 2 * D) - 0.057 * sind(Mm - 2 * D + Ms) + 0.053 * sind(Mm + 2 * D)
    + 0.046 * sind(2 * D - Ms) + 0.041 * sind(Mm - Ms) - 0.035 * sind(D)
    - 0.031 * sind(Mm + Ms) - 0.015 * sind(2 * F - 2 * D) + 0.011 * sind(Mm - 4 * D);
  lat += -0.173 * sind(F - 2 * D) - 0.055 * sind(Mm - F - 2 * D) - 0.046 * sind(Mm + F - 2 * D)
    + 0.033 * sind(F + 2 * D) + 0.017 * sind(2 * Mm + F);
  r += -0.58 * cosd(Mm - 2 * D) - 0.46 * cosd(2 * D);
  lon = rev(lon);
  const eq = eclToEqu(lon, lat, sun.ecl);
  const elong = Math.acos(cosd(lat) * cosd(lon - sun.lon)) * R2D; // угол Луна–Солнце
  const illum = (1 - cosd(elong)) / 2;
  const waxing = rev(lon - sun.lon) < 180;
  return { ra: eq.ra, dec: eq.dec, lon, lat, rEarth: r, distKm: r * 6371, elong, illum, waxing };
}

const PLANET_ELEMENTS = {
  mercury: d => ({ N: 48.3313 + 3.24587e-5 * d, i: 7.0047 + 5.0e-8 * d, w: 29.1241 + 1.01444e-5 * d, a: 0.387098, e: 0.205635 + 5.59e-10 * d, M: 168.6562 + 4.0923344368 * d }),
  venus:   d => ({ N: 76.6799 + 2.4659e-5 * d, i: 3.3946 + 2.75e-8 * d, w: 54.891 + 1.38374e-5 * d, a: 0.72333, e: 0.006773 - 1.302e-9 * d, M: 48.0052 + 1.6021302244 * d }),
  mars:    d => ({ N: 49.5574 + 2.11081e-5 * d, i: 1.8497 - 1.78e-8 * d, w: 286.5016 + 2.92961e-5 * d, a: 1.523688, e: 0.093405 + 2.516e-9 * d, M: 18.6021 + 0.5240207766 * d }),
  jupiter: d => ({ N: 100.4542 + 2.76854e-5 * d, i: 1.303 - 1.557e-7 * d, w: 273.8777 + 1.64505e-5 * d, a: 5.20256, e: 0.048498 + 4.469e-9 * d, M: 19.895 + 0.0830853001 * d }),
  saturn:  d => ({ N: 113.6634 + 2.3898e-5 * d, i: 2.4886 - 1.081e-7 * d, w: 339.3939 + 2.97661e-5 * d, a: 9.55475, e: 0.055546 - 9.499e-9 * d, M: 316.967 + 0.0334442282 * d }),
};

// Абсолютная яркость и фазовый член для формулы звёздной величины
const PLANET_MAG = {
  mercury: (rR, FV) => -0.36 + 5 * Math.log10(rR) + 0.027 * FV + 2.2e-13 * FV ** 6,
  venus:   (rR, FV) => -4.34 + 5 * Math.log10(rR) + 0.013 * FV + 4.2e-7 * FV ** 3,
  mars:    (rR, FV) => -1.51 + 5 * Math.log10(rR) + 0.016 * FV,
  jupiter: (rR, FV) => -9.25 + 5 * Math.log10(rR) + 0.014 * FV,
  saturn:  (rR, FV) => -9.0 + 5 * Math.log10(rR) + 0.044 * FV,
};

function planetPosition(id, jd, sun) {
  const d = jd - 2451543.5;
  const el = PLANET_ELEMENTS[id](d);
  const M = rev(el.M), E = kepler(M, el.e);
  const xv = el.a * (cosd(E) - el.e), yv = el.a * Math.sqrt(1 - el.e * el.e) * sind(E);
  const r = Math.hypot(xv, yv), vw = atan2d(yv, xv) + el.w;
  let xh = r * (cosd(el.N) * cosd(vw) - sind(el.N) * sind(vw) * cosd(el.i));
  let yh = r * (sind(el.N) * cosd(vw) + cosd(el.N) * sind(vw) * cosd(el.i));
  let zh = r * sind(vw) * sind(el.i);
  if (id === 'jupiter' || id === 'saturn') {           // взаимные возмущения гигантов
    let lon = atan2d(yh, xh), lat = atan2d(zh, Math.hypot(xh, yh));
    const Mj = rev(19.895 + 0.0830853001 * d), Ms = rev(316.967 + 0.0334442282 * d);
    if (id === 'jupiter') {
      lon += -0.332 * sind(2 * Mj - 5 * Ms - 67.6) - 0.056 * sind(2 * Mj - 2 * Ms + 21)
        + 0.042 * sind(3 * Mj - 5 * Ms + 21) - 0.036 * sind(Mj - 2 * Ms)
        + 0.022 * cosd(Mj - Ms) + 0.023 * sind(2 * Mj - 3 * Ms + 52) - 0.016 * sind(Mj - 5 * Ms - 69);
    } else {
      lon += 0.812 * sind(2 * Mj - 5 * Ms - 67.6) - 0.229 * cosd(2 * Mj - 4 * Ms - 2)
        + 0.119 * sind(Mj - 2 * Ms - 3) + 0.046 * sind(2 * Mj - 6 * Ms - 69) + 0.014 * sind(Mj - 3 * Ms + 32);
      lat += -0.02 * cosd(2 * Mj - 4 * Ms - 2) + 0.018 * sind(2 * Mj - 6 * Ms - 49);
    }
    xh = r * cosd(lat) * cosd(lon); yh = r * cosd(lat) * sind(lon); zh = r * sind(lat);
  }
  const xg = xh + sun.xs, yg = yh + sun.ys, zg = zh;       // переносим наблюдателя на Землю
  const R = Math.hypot(xg, yg, zg);
  const ye = yg * cosd(sun.ecl) - zg * sind(sun.ecl), ze = yg * sind(sun.ecl) + zg * cosd(sun.ecl);
  const s = sun.r;
  const FV = Math.acos(Math.max(-1, Math.min(1, (r * r + R * R - s * s) / (2 * r * R)))) * R2D;
  const elong = Math.acos(Math.max(-1, Math.min(1, (s * s + R * R - r * r) / (2 * s * R)))) * R2D;
  return {
    ra: rev(atan2d(ye, xg)), dec: atan2d(ze, Math.hypot(xg, ye)),
    distAU: R, mag: PLANET_MAG[id](r * R, FV), elong,
  };
}

// Прецессия: ось Земли медленно «гуляет», координаты каталога 2000 года сдвигаются
function precessFromJ2000(raDeg, decDeg, jd) {
  const years = (jd - 2451545.0) / 365.25;
  const dRA = (3.075 + 1.336 * sind(raDeg) * Math.tan(decDeg * D2R)) * years * 15 / 3600;
  const dDec = 20.04 * cosd(raDeg) * years / 3600;
  return { ra: rev(raDeg + dRA), dec: decDeg + dDec };
}

const PLANETS = [
  { id: 'mercury', name: 'Меркурий' }, { id: 'venus', name: 'Венера' }, { id: 'mars', name: 'Марс' },
  { id: 'jupiter', name: 'Юпитер' }, { id: 'saturn', name: 'Сатурн' },
];

// Полный снимок неба в момент ms для наблюдателя (lat, lon)
function skySnapshot(ms, lat, lon, stars) {
  const jd = julianDate(ms), lst = localSiderealDeg(jd, lon);
  const sun = sunPosition(jd);
  const sunHor = equToHor(sun.ra, sun.dec, lat, lst);
  sunHor.alt += refraction(sunHor.alt);

  const moon = moonPosition(jd, sun);
  const moonHor = equToHor(moon.ra, moon.dec, lat, lst);
  const parallax = asind(1 / moon.rEarth);                 // Луна близко: поправка на ~1°
  moonHor.alt -= parallax * cosd(moonHor.alt);
  moonHor.alt += refraction(moonHor.alt);

  const planets = PLANETS.map(p => {
    const pos = planetPosition(p.id, jd, sun);
    const hor = equToHor(pos.ra, pos.dec, lat, lst);
    hor.alt += refraction(hor.alt);
    return { ...p, ...pos, ...hor };
  });

  const starList = (stars || []).map(s => {
    const p = precessFromJ2000(s.ra * 15, s.dec, jd);
    const hor = equToHor(p.ra, p.dec, lat, lst);
    hor.alt += refraction(hor.alt);
    return { ...s, ...hor };
  });

  // Эклиптика — дорога Солнца, Луны и планет по небу
  const ecliptic = [];
  for (let L = 0; L < 360; L += 4) {
    const eq = eclToEqu(L, 0, sun.ecl);
    ecliptic.push(equToHor(eq.ra, eq.dec, lat, lst));
  }

  return {
    ms, jd, lst,
    sun: { id: 'sun', name: 'Солнце', ...sun, ...sunHor, mag: -26.7 },
    moon: { id: 'moon', name: 'Луна', ...moon, ...moonHor, mag: -12.7 * moon.illum - 0.3 * (1 - moon.illum) },
    planets, stars: starList, ecliptic,
  };
}

function sunAltAt(ms, lat, lon) {
  const jd = julianDate(ms), sun = sunPosition(jd);
  const h = equToHor(sun.ra, sun.dec, lat, localSiderealDeg(jd, lon));
  return h.alt;
}

// Ищем моменты, когда функция высоты пересекает порог (восход/заход)
function findCrossings(altFn, fromMs, toMs, threshold, stepMin = 5) {
  const out = [], step = stepMin * 60000;
  let t0 = fromMs, a0 = altFn(t0) - threshold;
  for (let t1 = fromMs + step; t1 <= toMs; t1 += step) {
    const a1 = altFn(t1) - threshold;
    if (a0 < 0 !== a1 < 0) {
      let lo = t0, hi = t1, alo = a0;
      for (let k = 0; k < 20; k++) {
        const mid = (lo + hi) / 2, am = altFn(mid) - threshold;
        if (alo < 0 === am < 0) { lo = mid; alo = am; } else hi = mid;
      }
      out.push({ ms: (lo + hi) / 2, rising: a1 > a0 });
    }
    t0 = t1; a0 = a1;
  }
  return out;
}

const RUMBS = 'С ССВ СВ ВСВ В ВЮВ ЮВ ЮЮВ Ю ЮЮЗ ЮЗ ЗЮЗ З ЗСЗ СЗ ССЗ'.split(' ');
const RUMB_WORDS = ['север', 'северо-северо-восток', 'северо-восток', 'восток-северо-восток', 'восток',
  'восток-юго-восток', 'юго-восток', 'юго-юго-восток', 'юг', 'юго-юго-запад', 'юго-запад',
  'запад-юго-запад', 'запад', 'запад-северо-запад', 'северо-запад', 'северо-северо-запад'];
const rumbIndex = az => Math.floor((rev(az) + 11.25) / 22.5) % 16;
const rumb = az => RUMBS[rumbIndex(az)];
const rumbWord = az => RUMB_WORDS[rumbIndex(az)];

if (typeof module !== 'undefined') {
  module.exports = { julianDate, localSiderealDeg, equToHor, sunPosition, moonPosition,
    planetPosition, skySnapshot, sunAltAt, findCrossings, rumb, rumbWord, precessFromJ2000, PLANETS };
}
