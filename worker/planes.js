// Cloudflare Worker — посредник между сайтом и бесплатными источниками ADS-B.
// Источники не разрешают браузеру брать данные с чужого сайта (нет CORS), а посредник разрешает.
// Заодно он ужимает ответ до нужных полей и держит его в кэше несколько секунд, чтобы не дёргать источник.
//
//   GET https://<имя>.workers.dev/?lat=32.33&lon=34.86&dist=60   (dist — радиус в морских милях, до 100)

const ALLOWED_ORIGINS = ['https://synex-os.github.io', 'http://localhost:8765', 'http://localhost:8766'];
const CACHE_SECONDS = 4;

// adsb.fi: личное некоммерческое использование, просят ссылку на источник; лимит 1 запрос в секунду.
// adsb.lol: открытые данные (ODbL), лимит 500 запросов в сутки — только запасной.
const SOURCES = [
  { name: 'adsb.fi', url: (lat, lon, d) => `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${d}`, list: j => j.aircraft },
  { name: 'adsb.lol', url: (lat, lon, d) => `https://api.adsb.lol/v2/point/${lat}/${lon}/${d}`, list: j => j.ac },
];

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

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') return new Response(null, { headers: { ...cors(origin), 'Access-Control-Allow-Methods': 'GET' } });

    const q = new URL(request.url).searchParams;
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
      try {
        const r = await fetch(src.url(rl, ro, dist), { headers: { 'User-Agent': 'sky-radar (github.com/synex-os/sky-radar)' } });
        if (!r.ok) { errors.push(`${src.name}: ${r.status}`); continue; }
        const j = await r.json();
        const body = JSON.stringify({ src: src.name, now: Date.now(), ac: (src.list(j) || []).filter(a => a.lat != null).map(slim) });
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
