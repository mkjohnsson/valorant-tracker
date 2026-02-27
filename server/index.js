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

// Map images from valorant-api.com (cached in-memory indefinitely — changes rarely)
let mapsCache = null;
async function getMapImages() {
  if (mapsCache) return mapsCache;
  try {
    const r = await fetch('https://valorant-api.com/v1/maps');
    const json = await r.json();
    const lookup = {};
    for (const map of json?.data || []) {
      if (map.displayName && map.displayName !== 'The Range') {
        lookup[map.displayName] = {
          splash: map.splash,
          listViewIcon: map.listViewIcon,
        };
      }
    }
    mapsCache = lookup;
  } catch { mapsCache = {}; }
  return mapsCache;
}

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

  const [accountRes, mmrRes, mmrHistoryRes, matchesRes, leaderboardRes] = await Promise.allSettled([
    fetch(`${HENRIK_BASE}/v2/account/${encodedName}/${encodedTag}`, { headers }),
    fetch(`${HENRIK_BASE}/v3/mmr/${region}/pc/${encodedName}/${encodedTag}`, { headers }),
    fetch(`${HENRIK_BASE}/v2/mmr-history/${region}/pc/${encodedName}/${encodedTag}?size=20`, { headers }),
    fetch(`${HENRIK_BASE}/v4/matches/${region}/pc/${encodedName}/${encodedTag}?mode=competitive&size=20`, { headers }),
    fetch(`${HENRIK_BASE}/v2/leaderboard/${region}?name=${encodedName}&tag=${encodedTag}`, { headers }),
  ]);

  // Parse — throws on API error (for critical endpoints)
  async function parse(settled) {
    if (settled.status === 'rejected') return null;
    const r = settled.value;
    if (!r.ok) {
      const text = await r.text();
      throw Object.assign(new Error(`Henrik API error ${r.status}`), { status: r.status, body: text });
    }
    return r.json();
  }

  // Safe parse — returns null on any error (for non-critical endpoints)
  async function parseSafe(settled) {
    if (settled.status === 'rejected') return null;
    try {
      const r = settled.value;
      if (!r.ok) return null;
      return r.json();
    } catch { return null; }
  }

  const [account, mmrRaw, mmrHistory, matches, leaderboard] = await Promise.all([
    parse(accountRes),
    parse(mmrRes),
    parse(mmrHistoryRes),
    parse(matchesRes),
    parseSafe(leaderboardRes),
  ]);

  // Keep current, peak AND seasonal history
  const mmr = mmrRaw?.data
    ? { ...mmrRaw, data: { current: mmrRaw.data.current, peak: mmrRaw.data.peak, seasonal: mmrRaw.data.seasonal } }
    : mmrRaw;

  // Build RR-change lookup from mmrHistory (match_id → last_change)
  const historyList = mmrHistory?.data?.history || [];
  const rrByMatchId = {};
  for (const entry of historyList) {
    if (entry.match_id) rrByMatchId[entry.match_id] = entry.last_change;
  }

  // Map images for embedding per match
  const mapImages = await getMapImages();

  // Aggregate weapon stats from round data (no extra API calls — rounds are in the matches response)
  const weaponStatsMap = {};
  for (const m of matches?.data || []) {
    const myPuuid = (m.players || []).find(p =>
      p.name?.toLowerCase() === name.toLowerCase() &&
      p.tag?.toLowerCase() === tag.toLowerCase()
    )?.puuid;
    if (!myPuuid) continue;
    for (const round of m.rounds || []) {
      const ps = (round.stats || []).find(s => s.player?.puuid === myPuuid);
      if (!ps) continue;
      const w = ps.economy?.weapon;
      if (!w || w.type !== 'Weapon') continue;
      if (!weaponStatsMap[w.name]) {
        weaponStatsMap[w.name] = {
          id: w.id,
          name: w.name,
          rounds: 0,
          kills: 0,
          icon: `https://media.valorant-api.com/weapons/${w.id}/displayicon.png`,
        };
      }
      weaponStatsMap[w.name].rounds++;
      weaponStatsMap[w.name].kills += ps.stats?.kills ?? 0;
    }
  }
  const weaponStats = Object.values(weaponStatsMap).sort((a, b) => b.rounds - a.rounds);

  // Trim matches — pre-process with v4 structure
  const trimmedMatches = matches?.data?.map(m => {
    const matchId = m.metadata?.match_id;
    const me = (m.players || []).find(p =>
      p.name?.toLowerCase() === name.toLowerCase() &&
      p.tag?.toLowerCase() === tag.toLowerCase()
    );
    const myTeam = m.teams?.find(t => t.team_id === me?.team_id);
    const mapName = m.metadata?.map?.name || String(m.metadata?.map || '?');
    return {
      map: mapName,
      map_image: mapImages[mapName]?.listViewIcon || null,
      started_at: m.metadata?.started_at,
      won: myTeam?.won ?? false,
      rr_change: rrByMatchId[matchId] ?? null,
      me: me ? {
        character: me.agent?.name || '?',
        agent_icon: me.agent?.id
          ? `https://media.valorant-api.com/agents/${me.agent.id}/displayicon.png`
          : null,
        kills: me.stats?.kills ?? 0,
        deaths: me.stats?.deaths ?? 0,
        assists: me.stats?.assists ?? 0,
        score: me.stats?.score ?? 0,
        headshots: me.stats?.headshots ?? 0,
        bodyshots: me.stats?.bodyshots ?? 0,
        legshots: me.stats?.legshots ?? 0,
      } : null,
    };
  }) || [];

  // Leaderboard position (only for Immortal+)
  const leaderboardRank = leaderboard?.data?.leaderboardRank || null;

  const data = { account, mmr, mmrHistory, matches: trimmedMatches, leaderboardRank, weaponStats };

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

// Live match detection (not cached — must be real-time)
app.get('/api/live/:region/:name/:tag', async (req, res) => {
  const { region, name, tag } = req.params;
  const apiKey = process.env.VALORANT_API_KEY;
  const headers = apiKey ? { Authorization: apiKey } : {};
  try {
    const r = await fetch(
      `${HENRIK_BASE}/v1/lifecycle/player/${region}/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`,
      { headers, signal: AbortSignal.timeout(5000) }
    );
    if (!r.ok) return res.json({ inGame: false });
    const data = await r.json();
    res.json({ inGame: true, data });
  } catch {
    res.json({ inGame: false });
  }
});

// Map images endpoint
app.get('/api/maps', async (_req, res) => {
  res.json(await getMapImages());
});

const PORT = process.env.PORT || 5008;
app.listen(PORT, () => console.log(`Valorant Tracker kör på port ${PORT}`));
