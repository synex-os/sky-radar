// Cloudflare Worker — посредник между сайтом и бесплатными источниками ADS-B.
// Источники не разрешают браузеру брать данные с чужого сайта (нет CORS), а посредник разрешает.
// Заодно он ужимает ответ до нужных полей и держит его в кэше несколько секунд, чтобы не дёргать источник.
//
//   GET https://<имя>.workers.dev/?lat=32.33&lon=34.86&dist=60   (dist — радиус в морских милях, до 100)
//   GET https://<имя>.workers.dev/?probe=1                        (разведка: что отвечает каждый источник)

const ALLOWED_ORIGINS = ['https://synex-os.github.io', 'http://localhost:8765', 'http://localhost:8766'];
const CACHE_SECONDS = 6;
const COOLDOWN_SECONDS = 120;            // источник ответил «много запросов» — не трогаем его пару минут
const UA = 'sky-radar (github.com/synex-os/sky-radar)';

// Пробуем по очереди. У всех — условия для личного некоммерческого использования; ссылка на источник — на сайте.
const SOURCES = [
  { name: 'adsb.fi', url: (lat, lon, d) => `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${d}`, list: j => j.aircraft },
  { name: 'airplanes.live', url: (lat, lon, d) => `https://api.airplanes.live/v2/point/${lat}/${lon}/${d}`, list: j => j.ac },
  { name: 'adsb.one', url: (lat, lon, d) => `https://api.adsb.one/v2/point/${lat}/${lon}/${d}`, list: j => j.ac },
  { name: 'adsb.lol', url: (lat, lon, d) => `https://api.adsb.lol/v2/point/${lat}/${lon}/${d}`, list: j => j.ac },
  { name: 'opensky', url: openskyUrl, list: openskyList },
];

// OpenSky отдаёт прямоугольник и массивы вместо объектов, в метрах — переводим в вид остальных источников
function openskyUrl(lat, lon, d) {
  const dLat = d / 60, dLon = d / 60 / Math.cos(lat * Math.PI / 180);
  return `https://opensky-network.org/api/states/all?lamin=${(lat - dLat).toFixed(2)}&lamax=${(lat + dLat).toFixed(2)}`
    + `&lomin=${(lon - dLon).toFixed(2)}&lomax=${(lon + dLon).toFixed(2)}`;
}
function openskyList(j) {
  const now = j.time || Date.now() / 1000;
  return (j.states || []).map(s => ({
    hex: s[0], flight: s[1], lon: s[5], lat: s[6], alt_baro: s[8] ? 'ground' : s[7] == null ? undefined : s[7] / 0.3048,
    alt_geom: s[13] == null ? undefined : s[13] / 0.3048, gs: s[9] == null ? undefined : s[9] / 0.514444, track: s[10],
    geom_rate: s[11] == null ? undefined : s[11] / 0.3048 * 60, squawk: s[14], seen_pos: s[3] ? Math.max(0, now - s[3]) : 0,
    mlat: s[16] === 2,
  }));
}

const KEEP = ['hex', 'flight', 'r', 't', 'desc', 'category', 'lat', 'lon', 'alt_geom', 'alt_baro', 'gs', 'track',
  'geom_rate', 'baro_rate', 'seen_pos', 'squawk', 'emergency', 'nic', 'nac_p', 'mlat', 'type'];

function cors(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return { 'Access-Control-Allow-Origin': allow, 'Vary': 'Origin' };
}

function slim(a) {
  const o = {};
  for (const k of KEEP) if (a[k] !== undefined) o[k] = a[k];
  if (Array.isArray(o.mlat)) o.mlat = o.mlat.length > 0;     // нам важно лишь «позиция по мультилатерации»
  return o;
}

const cooldownKey = name => new Request(`https://planes.cache/cooldown/${name}`);

async function probe(origin) {
  const out = [];
  for (const src of SOURCES) {
    const t = Date.now();
    try {
      const r = await fetch(src.url(32.3, 34.9, 60), { headers: { 'User-Agent': UA } });
      let n = '';
      if (r.ok) { try { n = (src.list(await r.json()) || []).length + ' самолётов'; } catch (e) { n = 'не JSON'; } }
      out.push(`${src.name}: ${r.status} ${n} ${Date.now() - t}мс`);
    } catch (e) {
      out.push(`${src.name}: ${e.message}`);
    }
  }
  return Response.json({ probe: out }, { headers: cors(origin) });
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') return new Response(null, { headers: { ...cors(origin), 'Access-Control-Allow-Methods': 'GET' } });

    const q = new URL(request.url).searchParams;
    if (q.get('probe')) return probe(origin);
    const lat = Number(q.get('lat')), lon = Number(q.get('lon'));
    const dist = Math.min(100, Math.max(5, Math.round(Number(q.get('dist')) || 60)));
    if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) {
      return Response.json({ error: 'нужны lat и lon' }, { status: 400, headers: cors(origin) });
    }
    // округляем место до ~10 км: соседние запросы попадают в один кэш
    const rl = Math.round(lat * 10) / 10, ro = Math.round(lon * 10) / 10;
    const cache = caches.default, key = new Request(`https://planes.cache/${rl}/${ro}/${dist}`);
    const hit = await cache.match(key);
    if (hit) return new Response(hit.body, { headers: { ...Object.fromEntries(hit.headers), ...cors(origin) } });

    const errors = [];
    for (const src of SOURCES) {
      if (await cache.match(cooldownKey(src.name))) { errors.push(`${src.name}: пауза после отказа`); continue; }
      try {
        const r = await fetch(src.url(rl, ro, dist), { headers: { 'User-Agent': UA } });
        if (!r.ok) {
          errors.push(`${src.name}: ${r.status}`);
          if (r.status === 429 || r.status === 403) {
            ctx.waitUntil(cache.put(cooldownKey(src.name), new Response('1', { headers: { 'Cache-Control': `public, max-age=${COOLDOWN_SECONDS}` } })));
          }
          continue;
        }
        const j = await r.json();
        const body = JSON.stringify({ src: src.name, now: Date.now(), skipped: errors, ac: (src.list(j) || []).filter(a => a.lat != null).map(slim) });
        const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${CACHE_SECONDS}` };
        ctx.waitUntil(cache.put(key, new Response(body, { headers })));
        return new Response(body, { headers: { ...headers, ...cors(origin) } });
      } catch (e) {
        errors.push(`${src.name}: ${e.message}`);
      }
    }
    return Response.json({ error: 'источники не ответили', details: errors }, { status: 502, headers: cors(origin) });
  },
};
