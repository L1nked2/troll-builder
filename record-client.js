/* Browser-only DEEPLOL adapter. No API keys, proxy, filesystem or persistent storage. */
(function (root) {
  "use strict";
  const API = "https://b2c-api-cdn.deeplol.gg/";
  const DDRAGON = "https://ddragon.leagueoflegends.com/";
  const TIERS = ["IRON", "BRONZE", "SILVER", "GOLD", "PLATINUM", "EMERALD", "DIAMOND", "MASTER", "GRANDMASTER", "CHALLENGER"];
  const QUEUES = { 420: "솔로랭크", 440: "자유랭크", 450: "칼바람나락", 430: "일반", 400: "일반", 1900: "우르프", 1700: "아레나" };
  const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
  const round = (value, digits = 1) => Number(number(value).toFixed(digits));
  const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

  function parseRiotId(value) {
    const text = String(value || "").trim();
    const split = text.lastIndexOf("#");
    const name = text.slice(0, split).trim();
    const tag = text.slice(split + 1).trim();
    if (split < 1 || !name || !tag || name.includes("#") || /[\u0000-\u001f]/.test(text)) {
      throw new Error("Riot ID를 닉네임#태그 형식으로 입력해주세요.");
    }
    return { riot_id_name: name, riot_id_tag_line: tag };
  }

  function playerKey(player) {
    return `${player.riot_id_name.trim().toLowerCase()}#${player.riot_id_tag_line.trim().toLowerCase()}`;
  }

  function parseBudget(value, fallback) {
    if (String(value).trim() === "" && fallback !== undefined) return fallback;
    const budget = Number(value);
    if (String(value).trim() === "" || !Number.isSafeInteger(budget) || budget < 0 || budget > 1000000) {
      throw new Error("예산은 0~1,000,000 사이의 정수로 입력해주세요.");
    }
    return budget;
  }

  function emptyRank() {
    return { tier: "UNRANKED", division: 0, lp: 0, wins: 0, losses: 0, win_rate: 0 };
  }

  function makePlayer(entry, id) {
    return { ...entry, client_id: id, puu_id: null, level: 0, profile_icon_id: 29,
      tier_info: { solo: emptyRank(), flex: emptyRank() }, top_champions: [], recent_matches: [],
      season_history: [], solo_lp_graph: null, flex_lp_graph: null, updated_at: null,
      record_status: "idle", record_error: "", record_warning: "" };
  }

  function parseRank(value) {
    if (value === undefined || value === null) return emptyRank();
    if (!isObject(value) || typeof value.tier !== "string") throw new Error("랭크 응답 형식이 변경되었습니다.");
    if (value.tier === "" || value.tier === "UNRANKED") return emptyRank();
    if (!TIERS.includes(value.tier)) throw new Error("알 수 없는 랭크가 반환되었습니다.");
    const wins = number(value.wins), losses = number(value.losses);
    return { tier: value.tier, division: number(value.division), lp: number(value.league_points),
      wins, losses, win_rate: wins + losses ? round(wins / (wins + losses) * 100) : 0 };
  }

  function championMeta(mapping, id) {
    return mapping[String(id)] || { name_kr: `챔피언 ${id}`, name_en: "Garen", image: "Garen.png" };
  }

  function parseChampions(data, mapping) {
    const rows = data?.counter_champion_stats?.total?.enemy_champion_stats?.All;
    if (!Array.isArray(rows)) throw new Error("챔피언 통계 응답 형식이 변경되었습니다.");
    return rows.filter(c => isObject(c) && number(c.champion_id) > 0)
      .sort((a, b) => number(b.games) - number(a.games)).slice(0, 10).map(c => ({
        champion_id: String(c.champion_id), ...championMeta(mapping, c.champion_id),
        games: number(c.games), win_rate: round(c.win_rate), kda: round(c.kda, 2),
        kills: round(c.kills), deaths: round(c.deaths), assists: round(c.assists)
      }));
  }

  function parseMatches(data, puuid, mapping) {
    if (!Array.isArray(data?.match_json_list)) throw new Error("최근 전적 응답 형식이 변경되었습니다.");
    return data.match_json_list.slice(0, 10).map(match => {
      if (!Array.isArray(match?.participants_list)) throw new Error("최근 전적의 참가자 응답 형식이 변경되었습니다.");
      const part = match.participants_list.find(p => p?.puu_id === puuid);
      if (!part) throw new Error("최근 경기에서 참가자 정보를 찾을 수 없습니다.");
      const basic = match.match_basic_dict || {}, stats = part.final_stat_dict || {};
      const meta = championMeta(mapping, part.champion_id);
      let timestamp = number(basic.creation_timestamp);
      if (timestamp < 1e11) timestamp *= 1000;
      return { win: Boolean(part.is_win), queue_type: QUEUES[basic.queue_id] || "기타",
        champion_name_kr: meta.name_kr, champion_name_en: meta.name_en, champion_image: meta.image,
        kills: number(stats.kills), deaths: number(stats.deaths), assists: number(stats.assists),
        duration: number(basic.game_duration), timestamp };
    });
  }

  function parseSeasons(rows) {
    if (!Array.isArray(rows)) return [];
    const divisions = ["", "I", "II", "III", "IV"];
    return rows.filter(row => isObject(row) && TIERS.includes(row.tier)).sort((a, b) => number(b.season) - number(a.season)).map(row => {
      const division = divisions[number(row.division)] || "";
      return { season: `시즌 ${number(row.season)}`, tipsy: `최종 기록: ${row.tier} ${division} - ${number(row.lp)}<BR>` };
    });
  }

  function appendSnapshot(graph, rank, at) {
    if (rank.tier === "UNRANKED") return graph || null;
    const index = TIERS.indexOf(rank.tier);
    const y = index >= 7 ? 2800 + rank.lp : index * 400 + (4 - (rank.division || 4)) * 100 + rank.lp;
    const label = new Date(at).toLocaleTimeString("ko-KR", { hour12: false });
    return { labels: [...(graph?.labels || []), label].slice(-20),
      data: [...(graph?.data || []), { y, name: `${rank.tier} ${rank.division || ""} ${rank.lp} LP` }].slice(-20) };
  }

  function createClient(fetchImpl = root.fetch.bind(root), timeoutMs = 15000) {
    let metadataPromise = null;
    async function request(base, path, params = {}) {
      const url = new URL(path, base);
      Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url.toString(), { signal: controller.signal, mode: "cors", credentials: "omit", cache: "no-store" });
        if (!response.ok) {
          if (response.status === 404) throw new Error("유저 또는 전적을 찾을 수 없습니다. Riot ID와 KR 서버를 확인해주세요.");
          if (response.status === 429) throw new Error("전적 서버의 요청 한도에 도달했습니다. 잠시 후 다시 시도해주세요.");
          throw new Error(`전적 서버 오류 (${response.status}). 잠시 후 다시 시도해주세요.`);
        }
        try { return await response.json(); } catch { throw new Error("전적 서버가 올바른 JSON을 반환하지 않았습니다."); }
      } catch (error) {
        if (error.name === "AbortError") throw new Error("전적 조회 시간이 초과되었습니다. 다시 시도해주세요.");
        if (error instanceof TypeError) throw new Error("전적 서버에 연결할 수 없습니다. 네트워크 또는 API의 CORS 허용 상태를 확인해주세요.");
        throw error;
      } finally { clearTimeout(timer); }
    }

    async function loadMetadata() {
      const [versions, seasons] = await Promise.allSettled([
        request(DDRAGON, "api/versions.json"), request(API, "common/season-list")
      ]);
      const version = versions.status === "fulfilled" && /^\d+\.\d+\.\d+$/.test(versions.value?.[0]) ? versions.value[0] : "13.24.1";
      const seasonList = seasons.status === "fulfilled" ? seasons.value?.season_list : [];
      const season = Array.isArray(seasonList) && seasonList.length ? Math.max(...seasonList.map(number)) : null;
      const mapping = {};
      try {
        const response = await request(API, "common/champion-info", { version: version.split(".").slice(0, 2).join(".") });
        const rows = Array.isArray(response) ? response : response.champions;
        if (!Array.isArray(rows) || !rows.length) throw new Error("챔피언 메타데이터 없음");
        rows.forEach(c => {
          if (/^[A-Za-z0-9]+$/.test(c.champion_name_en)) mapping[String(c.champion_id)] = {
            name_kr: String(c.champion_name_kr || c.champion_name_en), name_en: c.champion_name_en, image: `${c.champion_name_en}.png`
          };
        });
      } catch {
        try {
          const response = await request(DDRAGON, `cdn/${version}/data/ko_KR/champion.json`);
          Object.values(response.data || {}).forEach(c => {
            if (/^[A-Za-z0-9]+$/.test(c.id)) mapping[String(c.key)] = { name_kr: String(c.name), name_en: c.id, image: `${c.id}.png` };
          });
        } catch { /* Numeric champion labels remain usable. Retry metadata on the next refresh. */ }
      }
      if (!season || !Object.keys(mapping).length || versions.status === "rejected") metadataPromise = null;
      return { version, season, mapping };
    }

    async function fetchPlayer(player) {
      if (!metadataPromise) metadataPromise = loadMetadata();
      const [metadata, profile] = await Promise.all([
        metadataPromise,
        request(API, "summoner/summoner", { riot_id_name: encodeURIComponent(player.riot_id_name), riot_id_tag_line: player.riot_id_tag_line, platform_id: "KR" })
      ]);
      const basic = profile?.summoner_basic_info_dict;
      if (!isObject(basic) || typeof basic.puu_id !== "string" || !basic.puu_id) throw new Error("소환사 정보를 찾을 수 없습니다. Riot ID를 확인해주세요.");
      const params = { puu_id: basic.puu_id, platform_id: "KR" };
      const [tierData, matchData, championData] = await Promise.allSettled([
        request(API, "summoner/summoner-realtime", { ...params, summoner_id: basic.summoner_id || "" }),
        request(API, "match/matches", { ...params, offset: 0, count: 10, queue_type: "ALL", champion_id: 0, only_list: 0, last_updated_at: 0 }),
        metadata.season ? request(API, "summoner/champion-stat", { ...params, season: metadata.season }) : Promise.reject(new Error("시즌 정보를 조회하지 못했습니다."))
      ]);
      // Essential requests are atomic: a failure never replaces previously usable records.
      if (tierData.status === "rejected") throw tierData.reason;
      if (matchData.status === "rejected") throw matchData.reason;
      const ranks = tierData.value?.season_tier_info_dict;
      if (!isObject(ranks)) throw new Error("랭크 응답 형식이 변경되었습니다.");
      const tier_info = { solo: parseRank(ranks.ranked_solo_5x5), flex: parseRank(ranks.ranked_flex_sr) };
      const recent_matches = parseMatches(matchData.value, basic.puu_id, metadata.mapping);
      let top_champions = player.top_champions, warning = "";
      try {
        if (championData.status === "rejected") throw championData.reason;
        top_champions = parseChampions(championData.value, metadata.mapping);
      } catch { warning = "챔피언 통계를 불러오지 못해 기존 통계를 유지했습니다. 다시 갱신해주세요."; }
      const at = new Date().toISOString();
      return { version: metadata.version, stats: {
        puu_id: basic.puu_id, level: number(basic.level), profile_icon_id: number(basic.profile_id) || 29,
        tier_info, recent_matches, top_champions, season_history: parseSeasons(basic.previous_season_tier_list),
        solo_lp_graph: appendSnapshot(player.solo_lp_graph, tier_info.solo, at),
        flex_lp_graph: appendSnapshot(player.flex_lp_graph, tier_info.flex, at),
        updated_at: at, record_warning: warning
      } };
    }
    return { fetchPlayer };
  }

  const exports = { parseRiotId, playerKey, parseBudget, makePlayer, createClient };
  root.RecordClient = exports;
  if (typeof module !== "undefined" && module.exports) module.exports = exports;
})(typeof globalThis !== "undefined" ? globalThis : window);
