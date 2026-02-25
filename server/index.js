import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.static(join(__dirname, '../public')));

const HENRIK_BASE = 'https://api.henrikdev.xyz/valorant';
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 min

// Supabase
const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY
  ? { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SECRET_KEY }
  : null;

async function supabaseGet(key) {
  if (!supabase) return null;
  try {
    const r = await fetch(`${supabase.url}/rest/v1/cache_entries?key=eq.${encodeURIComponent(key)}&select=data,fetched_at`, {
      headers: { apikey: supabase.key, Authorization: `Bearer ${supabase.key}` },
    });
    const rows = await r.json();
    if (!rows[0]) return null;
    const age = Date.now() - new Date(rows[0].fetched_at).getTime();
    if (age > CACHE_TTL_MS) return null;
    return rows[0].data;
  } catch { return null; }
}

async function supabaseSet(key, data) {
  if (!supabase) return;
  try {
    await fetch(`${supabase.url}/rest/v1/cache_entries`, {
      method: 'POST',
      headers: {
        apikey: supabase.key, Authorization: `Bearer ${supabase.key}`,
        'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify({ key, data, fetched_at: new Date().toISOString() }),
    });
  } catch { /* ignore */ }
}

// In-memory cache: { [cacheKey]: { data, time } }
const memCache = new Map();

async function getPlayerData(region, name, tag) {
  const cacheKey = `valorant_${region}_${name}_${tag}`.toLowerCase();

  // 1. In-memory (5 min)
  const mem = memCache.get(cacheKey);
  if (mem && Date.now() - mem.time < 5 * 60 * 1000) return mem.data;

  // 2. Supabase (15 min)
  const cached = await supabaseGet(cacheKey);
  if (cached) {
    memCache.set(cacheKey, { data: cached, time: Date.now() });
    return cached;
  }

  // 3. Fetch from Henrik's API
  const apiKey = process.env.VALORANT_API_KEY;
  const headers = apiKey ? { Authorization: apiKey } : {};

  const encodedName = encodeURIComponent(name);
  const encodedTag = encodeURIComponent(tag);

  const [accountRes, mmrRes, mmrHistoryRes, matchesRes] = await Promise.allSettled([
    fetch(`${HENRIK_BASE}/v2/account/${encodedName}/${encodedTag}`, { headers }),
    fetch(`${HENRIK_BASE}/v3/mmr/${region}/pc/${encodedName}/${encodedTag}`, { headers }),
    fetch(`${HENRIK_BASE}/v2/mmr-history/${region}/pc/${encodedName}/${encodedTag}?size=15`, { headers }),
    fetch(`${HENRIK_BASE}/v4/matches/${region}/pc/${encodedName}/${encodedTag}?mode=competitive&size=10`, { headers }),
  ]);

  // Parse each response
  async function parse(settled) {
    if (settled.status === 'rejected') return null;
    const r = settled.value;
    if (!r.ok) {
      const text = await r.text();
      throw Object.assign(new Error(`Henrik API error ${r.status}`), { status: r.status, body: text });
    }
    return r.json();
  }

  const [account, mmrRaw, mmrHistory, matches] = await Promise.all([
    parse(accountRes),
    parse(mmrRes),
    parse(mmrHistoryRes),
    parse(matchesRes),
  ]);

  // Strip seasonal history from mmr — we only need current rank
  const mmr = mmrRaw?.data
    ? { ...mmrRaw, data: { current: mmrRaw.data.current, peak: mmrRaw.data.peak } }
    : mmrRaw;

  const data = { account, mmr, mmrHistory, matches };

  memCache.set(cacheKey, { data, time: Date.now() });
  await supabaseSet(cacheKey, data);

  return data;
}

app.get('/api/player/:region/:name/:tag', async (req, res) => {
  const { region, name, tag } = req.params;
  try {
    const data = await getPlayerData(region, name, tag);
    res.json(data);
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 5008;
app.listen(PORT, () => console.log(`Valorant Tracker kör på port ${PORT}`));
