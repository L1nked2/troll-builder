const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRiotId, playerKey, parseBudget, makePlayer, createClient } = require('../record-client.js');

function fixtureFetch(overrides = {}) {
  const calls = [];
  const fetch = async (address, options) => {
    const url = new URL(address);
    calls.push({ url, options });
    if (overrides[url.pathname]) return overrides[url.pathname](url, options);
    const data = {
      '/api/versions.json': ['16.20.1'],
      '/common/season-list': { season_list: [26, 27] },
      '/common/champion-info': { champions: [{ champion_id: '86', champion_name_en: 'Garen', champion_name_kr: '가렌' }] },
      '/summoner/summoner': { summoner_basic_info_dict: { puu_id: 'provider-id', level: 100, profile_id: 42, previous_season_tier_list: [{ season: 25, tier: 'GOLD', division: 2, lp: 45 }] } },
      '/summoner/summoner-realtime': { season_tier_info_dict: { ranked_solo_5x5: { tier: 'GOLD', division: 2, league_points: 45, wins: 5, losses: 0 }, ranked_flex_sr: { tier: '', division: 0 } } },
      '/summoner/champion-stat': { counter_champion_stats: { total: { enemy_champion_stats: { All: [{ champion_id: '0', games: 100 }, { champion_id: '86', games: 20, win_rate: 55, kda: 2.75 }] } } } },
      '/match/matches': { match_json_list: [{ match_basic_dict: { creation_timestamp: 1790000000, game_duration: 1800, queue_id: 420 }, participants_list: [{ puu_id: 'provider-id', champion_id: 86, is_win: true, final_stat_dict: { kills: 8, deaths: 3, assists: 7 } }] }] }
    }[url.pathname];
    assert.notEqual(data, undefined, `Unexpected endpoint ${url.pathname}`);
    return { ok: true, json: async () => structuredClone(data) };
  };
  return { fetch, calls };
}
const sample = () => makePlayer({ ...parseRiotId('테스트 선수#K R'), position: '탑', initial_budget: 900 }, 'local-player');

test('Riot IDs normalize duplicates and reject incomplete inputs', () => {
  assert.deepEqual(parseRiotId('  Test Player # KR1  '), { riot_id_name: 'Test Player', riot_id_tag_line: 'KR1' });
  assert.equal(playerKey(parseRiotId('Test Player#KR1')), playerKey(parseRiotId('test player#kr1')));
  for (const value of ['', 'Name', '#KR1', 'Name#', 'Name#Tag#KR1', 'Name\n#KR1']) assert.throws(() => parseRiotId(value));
});

test('zero budget is valid, blank overrides inherit, invalid numbers fail', () => {
  assert.equal(parseBudget('0'), 0);
  assert.equal(parseBudget('', 950), 950);
  for (const value of ['', '-1', '0.5', 'NaN', '1000001']) assert.throws(() => parseBudget(value));
});

test('unqueried players have unique local identities independent of null provider IDs', () => {
  const first = sample();
  const second = makePlayer(parseRiotId('Other#KR1'), 'second-local-player');
  assert.equal(first.puu_id, null);
  assert.equal(second.puu_id, null);
  assert.notEqual(first.client_id, second.client_id);
  assert.equal(first.updated_at, null);
  assert.equal(first.record_status, 'idle');
});

test('live-shape responses map ranks, champions, matches and dynamic season without mutating input', async () => {
  const fixture = fixtureFetch();
  const client = createClient(fixture.fetch);
  const player = sample(), before = structuredClone(player);
  const { version, stats } = await client.fetchPlayer(player);
  assert.equal(version, '16.20.1');
  assert.equal(stats.tier_info.solo.win_rate, 100);
  assert.equal(stats.tier_info.flex.tier, 'UNRANKED');
  assert.equal(stats.top_champions.length, 1);
  assert.equal(stats.top_champions[0].name_kr, '가렌');
  assert.equal(stats.recent_matches[0].timestamp, 1790000000000);
  assert.equal(stats.recent_matches[0].queue_type, '솔로랭크');
  assert.equal(stats.recent_matches[0].kills, 8);
  assert.equal(stats.season_history[0].season, '시즌 25');
  assert.match(stats.season_history[0].tipsy, /GOLD II/);
  assert.equal(stats.solo_lp_graph.data[0].y, 1445);
  assert.deepEqual(player, before);
  const profile = fixture.calls.find(call => call.url.pathname === '/summoner/summoner');
  assert.equal(decodeURIComponent(profile.url.searchParams.get('riot_id_name')), '테스트 선수');
  assert.equal(profile.url.searchParams.get('riot_id_tag_line'), 'K R');
  assert.equal(fixture.calls.find(call => call.url.pathname === '/summoner/champion-stat').url.searchParams.get('season'), '27');
  assert.ok(fixture.calls.every(call => call.options.credentials === 'omit' && call.options.mode === 'cors'));
});

test('concurrent users share metadata requests', async () => {
  const fixture = fixtureFetch(), client = createClient(fixture.fetch);
  await Promise.all([client.fetchPlayer(sample()), client.fetchPlayer(sample())]);
  for (const path of ['/api/versions.json', '/common/season-list', '/common/champion-info']) {
    assert.equal(fixture.calls.filter(call => call.url.pathname === path).length, 1);
  }
});

test('required request failure leaves previous records untouched', async () => {
  const fixture = fixtureFetch({ '/match/matches': async () => ({ ok: false, status: 429 }) });
  const player = sample();
  player.recent_matches = [{ kills: 99 }];
  player.updated_at = '2026-10-01T00:00:00Z';
  const before = structuredClone(player);
  await assert.rejects(createClient(fixture.fetch).fetchPlayer(player), /요청 한도/);
  assert.deepEqual(player, before);
});

test('optional champion failures preserve previous champion stats and expose partial failure', async () => {
  const fixture = fixtureFetch({ '/summoner/champion-stat': async () => ({ ok: true, json: async () => ({ changed_schema: true }) }) });
  const player = sample();
  player.top_champions = [{ name_kr: '기존 챔피언' }];
  const { stats } = await createClient(fixture.fetch).fetchPlayer(player);
  assert.deepEqual(stats.top_champions, player.top_champions);
  assert.match(stats.record_warning, /기존 통계를 유지/);
  assert.equal(stats.recent_matches.length, 1);
});

test('malformed profile and match response cannot produce a false success', async () => {
  for (const path of ['/summoner/summoner', '/summoner/summoner-realtime', '/match/matches']) {
    const fixture = fixtureFetch({ [path]: async () => ({ ok: true, json: async () => ({}) }) });
    await assert.rejects(createClient(fixture.fetch).fetchPlayer(sample()));
  }
});

test('unknown ranks fail rather than overwriting a real rank as unranked', async () => {
  const fixture = fixtureFetch({ '/summoner/summoner-realtime': async () => ({ ok: true, json: async () => ({ season_tier_info_dict: { ranked_solo_5x5: { tier: 'CHANGED_SCHEMA' } } }) }) });
  await assert.rejects(createClient(fixture.fetch).fetchPlayer(sample()), /알 수 없는 랭크/);
});

test('not-found, invalid JSON, network and timeout errors have actionable messages', async () => {
  const cases = [
    [async () => ({ ok: false, status: 404 }), /찾을 수 없습니다/],
    [async () => ({ ok: true, json: async () => { throw new SyntaxError(); } }), /JSON/],
    [async () => { throw new TypeError('Failed to fetch'); }, /CORS/],
    [async (_, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => { const e = new Error(); e.name = 'AbortError'; reject(e); })), /시간이 초과/]
  ];
  for (const [fetch, message] of cases) await assert.rejects(createClient(fetch, 15).fetchPlayer(sample()), message);
});

test('LP snapshots accumulate in the current session with a bounded history', async () => {
  const client = createClient(fixtureFetch().fetch), player = sample();
  for (let i = 0; i < 22; i++) Object.assign(player, (await client.fetchPlayer(player)).stats);
  assert.equal(player.solo_lp_graph.data.length, 20);
  assert.equal(player.solo_lp_graph.labels.length, 20);
  assert.equal(player.flex_lp_graph, null);
  assert.equal(player.client_id, 'local-player');
  assert.equal(player.initial_budget, 900);
});
