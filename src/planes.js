// ===== Самолёты: ADS-B → где самолёт на небе прямо сейчас =====
// Самолёт сам каждые полсекунды сообщает в эфир, кто он, где и на какой высоте (ADS-B).
// Эти сообщения ловят любительские антенны и складывают на общую карту (adsb.fi, adsb.lol).
// Мы берём карту вокруг наблюдателя через посредника (Cloudflare Worker, см. worker/planes.js)
// и «упреждаем»: между запросами двигаем самолёт по его скорости и курсу.

const PLANES_PROXY = '';                  // адрес посредника; пока пусто — берём введённый на странице
const PLANES_RADIUS_NM = 60;              // ~110 км: дальше самолёт на крейсерской высоте ниже 5° над горизонтом
const PLANE_MAX_AGE = 60;                 // с: позицию старше минуты не показываем
const FT = 0.3048, KT = 0.514444;         // футы → метры, узлы → м/с

const AIRLINES = {
  ELY: 'Эль Аль', ISR: 'Израэйр', AIZ: 'Аркиа', WZZ: 'Wizz Air', WMT: 'Wizz Air Malta', RYR: 'Ryanair',
  EZY: 'easyJet', EJU: 'easyJet Europe', UAE: 'Emirates', FDB: 'flydubai', ETD: 'Etihad', THY: 'Turkish Airlines',
  PGT: 'Pegasus', AFR: 'Air France', DLH: 'Lufthansa', BAW: 'British Airways', KLM: 'KLM', SWR: 'Swiss',
  AUA: 'Austrian', LOT: 'LOT', AEE: 'Aegean', CYP: 'Cyprus Airways', UAL: 'United', DAL: 'Delta',
  AAL: 'American', ITY: 'ITA Airways', AZA: 'ITA Airways', IBE: 'Iberia', VLG: 'Vueling', TAP: 'TAP',
  RJA: 'Royal Jordanian', MSR: 'EgyptAir', GFA: 'Gulf Air', ABY: 'Air Arabia', ETH: 'Ethiopian',
  AIC: 'Air India', HFY: 'Hi Fly', SXS: 'SunExpress', ENT: 'Enter Air', BCS: 'DHL', UPS: 'UPS', FDX: 'FedEx',
  QTR: 'Qatar Airways', SVA: 'Saudia', KAC: 'Kuwait Airways', BTI: 'airBaltic', AFL: 'Аэрофлот',
};

// Точка на Земле (широта, долгота, высота в метрах) → координаты от центра Земли (WGS84)
function geoToEcef(latDeg, lonDeg, h) {
  const a = 6378137, e2 = 6.69437999014e-3, s = sind(latDeg), c = cosd(latDeg);
  const N = a / Math.sqrt(1 - e2 * s * s);
  return [(N + h) * c * cosd(lonDeg), (N + h) * c * sind(lonDeg), (N * (1 - e2) + h) * s];
}

// Куда смотреть: «восток-север-вверх» от наблюдателя → азимут, высота над горизонтом, расстояние
function lookFrom(obsLat, obsLon, obsH, lat, lon, h) {
  const o = geoToEcef(obsLat, obsLon, obsH), p = geoToEcef(lat, lon, h);
  const dx = p[0] - o[0], dy = p[1] - o[1], dz = p[2] - o[2];
  const sp = sind(obsLat), cp = cosd(obsLat), sl = sind(obsLon), cl = cosd(obsLon);
  const e = -sl * dx + cl * dy;
  const n = -sp * cl * dx - sp * sl * dy + cp * dz;
  const u = cp * cl * dx + cp * sl * dy + sp * dz;
  return { az: rev(atan2d(e, n)), alt: atan2d(u, Math.hypot(e, n)), range: Math.hypot(dx, dy, dz) / 1000 };
}

// Сдвинуть точку на distM метров по курсу trackDeg (по большому кругу)
function moveAlong(latDeg, lonDeg, trackDeg, distM) {
  const d = distM / 6371000, s = sind(latDeg), c = cosd(latDeg);
  const lat2 = Math.asin(s * Math.cos(d) + c * Math.sin(d) * cosd(trackDeg));
  const lon2 = lonDeg * D2R + Math.atan2(sind(trackDeg) * Math.sin(d) * c, Math.cos(d) - s * Math.sin(lat2));
  return [lat2 * R2D, ((lon2 * R2D + 540) % 360) - 180];
}

function planeAltM(a) {
  if (a.alt_baro === 'ground') return 0;
  const ft = typeof a.alt_geom === 'number' ? a.alt_geom : typeof a.alt_baro === 'number' ? a.alt_baro : null;
  return ft == null ? null : ft * FT;
}

// Сырые записи + момент получения → самолёты, готовые к расчёту положения
function preparePlanes(list, receivedMs) {
  const out = [];
  for (const a of list) {
    const h = planeAltM(a);
    if (h == null || a.lat == null) continue;
    const call = (a.flight || '').trim();
    out.push({
      id: a.hex, call, reg: a.r || '', type: a.desc || a.t || '', category: a.category || '',
      airline: AIRLINES[call.slice(0, 3)] || '', onGround: a.alt_baro === 'ground',
      lat: a.lat, lon: a.lon, h, gs: a.gs || 0, track: a.track, rate: a.geom_rate ?? a.baro_rate ?? 0,
      posMs: receivedMs - (a.seen_pos || 0) * 1000, squawk: a.squawk, emergency: a.emergency,
      mlat: !!a.mlat,
      // nic 0 или слабая точность при приёме по GPS — признак глушения/подмены GPS (часто бывает над Израилем)
      dubious: !a.mlat && (a.nic === 0 || (a.nac_p != null && a.nac_p <= 4)),
    });
  }
  return out;
}

// Где самолёт в момент ms: упреждение по скорости, курсу и вертикальной скорости
function planeAt(p, ms, obs) {
  const dt = (ms - p.posMs) / 1000;
  if (dt > PLANE_MAX_AGE) return null;
  const t = Math.max(0, dt);
  const [lat, lon] = p.track != null && !p.onGround ? moveAlong(p.lat, p.lon, p.track, p.gs * KT * t) : [p.lat, p.lon];
  const h = Math.max(0, p.h + (p.rate * FT / 60) * t);
  return { ...lookFrom(obs.lat, obs.lon, 30, lat, lon, h), lat, lon, h, age: dt };
}

function planeSky(planes, ms, obs) {
  const out = [];
  for (const p of planes) {
    if (p.onGround) continue;
    const l = planeAt(p, ms, obs);
    if (l && l.alt > 0) out.push({ plane: p, ...l });
  }
  return out;
}

async function fetchPlanes(proxy, lat, lon) {
  const url = `${proxy.replace(/\/+$/, '')}/?lat=${lat.toFixed(2)}&lon=${lon.toFixed(2)}&dist=${PLANES_RADIUS_NM}`;
  const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error || 'HTTP ' + res.status);
  return { src: j.src, receivedMs: Date.now(), planes: preparePlanes(j.ac || [], Date.now()) };
}
