/* ==========================================================================
   Troll Draft Application Logic (app.js) - LoL In-House Auction Draft Edition
   State management, dynamic team creation, point auctioning, stats modal, and export
   ========================================================================== */

// Global Application State
const state = {
  version: "13.24.1",     // Default DDragon version for assets
  initialBudget: 1000,    // Default budget if not specified in JSON
  allPlayers: [],         // General list of players (excluding captains)
  poolPlayers: [],        // Undrafted players currently in the pool
  captains: [],           // Dynamic captain players
  teams: [],              // Dynamic teams: { captain: obj, roster: [null, null, null, null], budget: 1000, bids: [0, 0, 0, 0] }
  nominatedPlayer: null,  // Player currently on the auction stage
  nominatedBid: 50,       // Current nominated bid amount
  filters: {
    search: "",
    tier: "ALL",
    position: "ALL"
  }
};

// Tier color maps for HTML badges
const TIER_COLORS = {
  "CHALLENGER": "#ff3366",
  "GRANDMASTER": "#e63946",
  "MASTER": "#9b5de5",
  "DIAMOND": "#00bbf9",
  "EMERALD": "#06d6a0",
  "PLATINUM": "#4ea8de",
  "GOLD": "#ffd166",
  "SILVER": "#cbd5e1",
  "BRONZE": "#cd7f32",
  "IRON": "#708284",
  "UNRANKED": "#64748b"
};

// Ordered tiers from lowest to highest for rank calculations
const TIER_ORDER = ["IRON", "BRONZE", "SILVER", "GOLD", "PLATINUM", "EMERALD", "DIAMOND", "MASTER", "GRANDMASTER", "CHALLENGER"];

let nomineeChartInstance = null;
let modalChartInstance = null;
let currentNomineeChartTab = "solo";
let currentModalTab = "solo";
let currentModalPlayer = null;

// Convert fow.lol continuous y-value to Rank Label
function getRankLabelFromY(y) {
  if (y === null || y === undefined || y === 0) return "UNRANKED";
  const tiers = ["IRON", "BRONZE", "SILVER", "GOLD", "PLATINUM", "EMERALD", "DIAMOND", "MASTER"];
  const tierIndex = Math.floor(y / 400);
  if (tierIndex < 0) return "IRON IV";
  if (tierIndex >= 7) {
    const lp = y - 2800;
    return `MASTER ${lp} LP`;
  }
  const tierName = tiers[tierIndex];
  const offset = y % 400;
  const divisionIndex = 4 - Math.floor(offset / 100);
  const lp = offset % 100;

  const divisions = ["", "I", "II", "III", "IV"];
  const divRoman = divisions[divisionIndex] || "IV";

  return `${tierName} ${divRoman} ${lp} LP`;
}

// Convert tipsy string to parsed object
function parseSeasonTipsy(tipsyStr) {
  if (!tipsyStr) return null;
  const match = tipsyStr.match(/(?:Final record|최종 기록)\s*:?\s*([A-Z\s]+?)(?:\s+([IVX]+))?\s*-\s*(\d+)/i);
  if (match) {
    const tier = match[1].trim().toUpperCase();
    const division = match[2] ? match[2].trim().toUpperCase() : "";
    const lp = parseInt(match[3]) || 0;
    return { tier, division, lp };
  }
  if (tipsyStr.includes("UNRANKED")) {
    return { tier: "UNRANKED", division: "", lp: 0 };
  }
  const matchNoLp = tipsyStr.match(/(?:Final record|최종 기록)\s*:?\s*([A-Z\s]+?)(?:\s+([IVX]+))?(?:<BR>|$)/i);
  if (matchNoLp) {
    const tier = matchNoLp[1].trim().toUpperCase();
    const division = matchNoLp[2] ? matchNoLp[2].trim().toUpperCase() : "";
    return { tier, division, lp: 0 };
  }
  return null;
}

// Map parsed tier to fow.lol continuous y-value scale
function tierToVal(tier, division, lp) {
  const t = (tier || "UNRANKED").toUpperCase();
  const tierIndex = TIER_ORDER.indexOf(t);
  if (tierIndex === -1) return 0;

  let divNum = 4;
  if (division === "I") divNum = 1;
  else if (division === "II") divNum = 2;
  else if (division === "III") divNum = 3;
  else if (division === "IV") divNum = 4;

  const base = tierIndex * 400;
  if (["MASTER", "GRANDMASTER", "CHALLENGER"].includes(t)) {
    return base + Math.min(lp || 0, 400);
  }

  const divOffset = (4 - divNum) * 100;
  return base + divOffset + Math.min(lp || 0, 99);
}

function getTightRankScale(values) {
  const numericValues = values.filter(value => Number.isFinite(value));
  if (numericValues.length === 0) return {};

  const minValue = Math.min(...numericValues);
  const maxValue = Math.max(...numericValues);
  const range = maxValue - minValue;
  const padding = range < 80 ? 80 : Math.max(50, Math.ceil(range * 0.18));
  const min = Math.max(0, Math.floor((minValue - padding) / 25) * 25);
  let max = Math.ceil((maxValue + padding) / 25) * 25;

  if (max - min < 120) {
    max = min + 120;
  }

  return { min, max };
}

function formatSeasonRecord(historyItem) {
  const parsed = parseSeasonTipsy(historyItem?.tipsy);
  if (!parsed) {
    return {
      season: historyItem?.season || "--",
      rank: "기록 없음",
      tier: "UNRANKED"
    };
  }

  const rankParts = [parsed.tier];
  if (parsed.division) rankParts.push(parsed.division);
  if (parsed.lp) rankParts.push(`${parsed.lp} LP`);

  return {
    season: historyItem?.season || "--",
    rank: rankParts.join(" "),
    tier: parsed.tier
  };
}

// Render LP chart for Nominee Card
function mergeGraphData(solo, flex) {
  const datesSet = new Set();
  if (solo && solo.labels) solo.labels.forEach(d => datesSet.add(d));
  if (flex && flex.labels) flex.labels.forEach(d => datesSet.add(d));
  
  function labelToValue(label) {
    if (!label) return 0;
    const currentMonth = new Date().getMonth() + 1;
    if (/^[Ss]\d+/.test(label)) {
      const season = parseInt(label.substring(1)) || 0;
      return (season - 16) * 1200 + 100;
    }
    const parts = label.split('.');
    if (parts.length === 2) {
      let m = parseInt(parts[0]) || 0;
      const d = parseInt(parts[1]) || 0;
      if (m > currentMonth) {
        m -= 12;
      }
      return m * 100 + d;
    }
    return 0;
  }
  
  // Sort dates chronologically safely (prevents NaN from breaking sorting)
  const sortedDates = Array.from(datesSet).sort((a, b) => {
    return labelToValue(a) - labelToValue(b);
  });
  
  const sliceSize = 15;
  const slicedDates = sortedDates.slice(-sliceSize);
  
  const soloData = [];
  const flexData = [];
  const soloTooltips = [];
  const flexTooltips = [];
  
  slicedDates.forEach(d => {
    // Solo
    let sIdx = solo ? solo.labels.indexOf(d) : -1;
    if (sIdx !== -1) {
      const pt = solo.data[sIdx];
      soloData.push(pt.y);
      soloTooltips.push(pt.name || getRankLabelFromY(pt.y));
    } else {
      soloData.push(null);
      soloTooltips.push(null);
    }
    
    // Flex
    let fIdx = flex ? flex.labels.indexOf(d) : -1;
    if (fIdx !== -1) {
      const pt = flex.data[fIdx];
      flexData.push(pt.y);
      flexTooltips.push(pt.name || getRankLabelFromY(pt.y));
    } else {
      flexData.push(null);
      flexTooltips.push(null);
    }
  });
  
  return {
    labels: slicedDates,
    soloData,
    flexData,
    soloTooltips,
    flexTooltips
  };
}

function getNomineeGraphConfig(player) {
  const soloGraph = player?.solo_lp_graph;
  const flexGraph = player?.flex_lp_graph;
  const hasSolo = soloGraph && soloGraph.data && soloGraph.data.length > 0;
  const hasFlex = flexGraph && flexGraph.data && flexGraph.data.length > 0;

  if (currentNomineeChartTab === "solo" && !hasSolo && hasFlex) {
    currentNomineeChartTab = "flex";
  } else if (currentNomineeChartTab === "flex" && !hasFlex && hasSolo) {
    currentNomineeChartTab = "solo";
  }

  const isSolo = currentNomineeChartTab === "solo";
  return {
    graph: isSolo ? soloGraph : flexGraph,
    hasSolo,
    hasFlex,
    label: isSolo ? "솔로랭크" : "자유랭크",
    tooltipLabel: isSolo ? "솔로" : "자유",
    color: isSolo ? "#ffd700" : "#00f2fe",
    backgroundColor: isSolo ? "rgba(255, 215, 0, 0.02)" : "rgba(0, 242, 254, 0.02)"
  };
}

function setNomineeChartTabButtons(hasSolo, hasFlex) {
  const soloBtn = document.getElementById("tab-nominee-solo-trend");
  const flexBtn = document.getElementById("tab-nominee-flex-trend");

  if (soloBtn) {
    soloBtn.classList.toggle("active", currentNomineeChartTab === "solo");
    soloBtn.disabled = !hasSolo;
  }
  if (flexBtn) {
    flexBtn.classList.toggle("active", currentNomineeChartTab === "flex");
    flexBtn.disabled = !hasFlex;
  }
}

function switchNomineeChartTab(tab) {
  if (!state.nominatedPlayer || currentNomineeChartTab === tab) return;
  currentNomineeChartTab = tab;
  renderNomineeChart(state.nominatedPlayer);
}

// Render LP chart for Nominee Card. Keep solo and flex separated so their timelines do not mix.
function renderNomineeChart(player) {
  if (nomineeChartInstance) {
    nomineeChartInstance.destroy();
    nomineeChartInstance = null;
  }

  const ctx = document.getElementById("nominee-lp-chart");
  const emptyEl = document.getElementById("nominee-chart-empty");
  if (!ctx) return;

  const { graph, hasSolo, hasFlex, label, tooltipLabel, color, backgroundColor } = getNomineeGraphConfig(player);
  setNomineeChartTabButtons(hasSolo, hasFlex);

  if (!hasSolo && !hasFlex) {
    ctx.style.display = "none";
    if (emptyEl) emptyEl.classList.remove("hidden");
    return;
  }

  if (!graph || !graph.data || graph.data.length === 0) {
    ctx.style.display = "none";
    if (emptyEl) emptyEl.classList.remove("hidden");
    return;
  }

  if (emptyEl) emptyEl.classList.add("hidden");
  ctx.style.display = "block";

  const labels = graph.labels.slice(-15);
  const dataPoints = graph.data.slice(-15);
  const chartData = dataPoints.map(p => p?.y ?? null);
  const tooltips = dataPoints.map(p => p?.name || getRankLabelFromY(p?.y));
  const yScale = getTightRankScale(chartData);

  nomineeChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label,
        data: chartData,
        borderColor: color,
        backgroundColor,
        borderWidth: 2,
        pointBackgroundColor: color,
        pointRadius: 2,
        pointHoverRadius: 4,
        fill: false,
        tension: 0.3
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(20, 20, 25, 0.95)',
          titleColor: '#fff',
          bodyColor: '#ffd700',
          borderColor: 'rgba(255, 215, 0, 0.3)',
          borderWidth: 1,
          callbacks: {
            label: function (context) {
              const index = context.dataIndex;
              return `${tooltipLabel}: ${tooltips[index] || '기록 없음'}`;
            }
          }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: '#8a8e9d', font: { size: 8 } }
        },
        y: {
          ...yScale,
          grid: { color: 'rgba(255,255,255,0.03)' },
          ticks: {
            color: '#8a8e9d',
            font: { size: 8 },
            stepSize: 400,
            callback: function (value) {
              const tiers = ["IRO", "BRO", "SIL", "GOL", "PLA", "EME", "DIA", "MAS"];
              const idx = Math.floor(value / 400);
              return tiers[idx] || "";
            }
          }
        }
      }
    }
  });
}

// Render Modal Tabbed Chart
function renderModalChart(player) {
  if (modalChartInstance) {
    modalChartInstance.destroy();
    modalChartInstance = null;
  }

  const ctx = document.getElementById("modal-trend-chart");
  const emptyEl = document.getElementById("modal-chart-empty");
  if (!ctx) return;

  ctx.style.display = "none";
  emptyEl.classList.add("hidden");

  let labels = [];
  let chartData = [];
  let tooltips = [];

  if (currentModalTab === "solo") {
    const graph = player.solo_lp_graph;
    if (graph && graph.data && graph.data.length > 0) {
      labels = graph.labels;
      chartData = graph.data.map(p => p.y);
      tooltips = graph.data.map(p => p.name || getRankLabelFromY(p.y));
    }
  } else if (currentModalTab === "flex") {
    const graph = player.flex_lp_graph;
    if (graph && graph.data && graph.data.length > 0) {
      labels = graph.labels;
      chartData = graph.data.map(p => p.y);
      tooltips = graph.data.map(p => p.name || getRankLabelFromY(p.y));
    }
  } else if (currentModalTab === "season") {
    const history = player.season_history || [];
    if (history.length > 0) {
      const chronHistory = [...history].reverse();
      chronHistory.forEach(h => {
        const parsed = parseSeasonTipsy(h.tipsy);
        if (parsed) {
          labels.push(h.season);
          chartData.push(tierToVal(parsed.tier, parsed.division, parsed.lp));

          let tooltipStr = `${h.season}: ${parsed.tier}`;
          if (parsed.division) tooltipStr += ` ${parsed.division}`;
          if (parsed.lp) tooltipStr += ` - ${parsed.lp} LP`;
          tooltips.push(tooltipStr);
        }
      });
    }
  }

  if (chartData.length === 0) {
    emptyEl.classList.remove("hidden");
    return;
  }

  ctx.style.display = "block";

  modalChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: 'Tier LP',
        data: chartData,
        borderColor: '#ffd700',
        backgroundColor: 'rgba(255, 215, 0, 0.05)',
        borderWidth: 2,
        pointBackgroundColor: '#ffd700',
        pointRadius: 3,
        pointHoverRadius: 5,
        fill: true,
        tension: 0.2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(20, 20, 25, 0.95)',
          titleColor: '#fff',
          bodyColor: '#ffd700',
          borderColor: 'rgba(255, 215, 0, 0.3)',
          borderWidth: 1,
          callbacks: {
            label: function (context) {
              return tooltips[context.dataIndex];
            }
          }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: '#8a8e9d', font: { size: 9 } }
        },
        y: {
          grid: { color: 'rgba(255,255,255,0.03)' },
          ticks: {
            color: '#8a8e9d',
            font: { size: 9 },
            stepSize: 400,
            callback: function (value) {
              const tiers = ["IRON", "BRONZE", "SILVER", "GOLD", "PLATINUM", "EMERALD", "DIAMOND", "MASTER"];
              const idx = Math.floor(value / 400);
              return tiers[idx] || "";
            }
          }
        }
      }
    }
  });
}

function switchModalTab(tab) {
  currentModalTab = tab;
  const tabs = ["solo", "flex", "season"];
  const ids = ["tab-solo-trend", "tab-flex-trend", "tab-season-history"];

  tabs.forEach((t, i) => {
    const btn = document.getElementById(ids[i]);
    if (btn) {
      if (t === tab) btn.classList.add("active");
      else btn.classList.remove("active");
    }
  });

  if (currentModalPlayer) {
    renderModalChart(currentModalPlayer);
  }
}
window.switchModalTab = switchModalTab;

// Initialize Application
document.addEventListener("DOMContentLoaded", () => {
  loadData();
  setupEventListeners();
});

// Fetch players_data.json generated by crawler
async function loadData() {
  const poolContainer = document.getElementById("player-pool-container");

  try {
    const response = await fetch("players_data.json");
    if (!response.ok) {
      throw new Error("데이터 파일을 불러올 수 없습니다. crawler.py를 실행했는지 확인해주세요.");
    }

    const data = await response.json();

    // Parse budget config
    if (data.initial_budget !== undefined) {
      state.initialBudget = parseInt(data.initial_budget);
    }

    // Parse captains and players
    state.captains = data.captains || [];
    state.allPlayers = data.players || [];

    // Set DDragon version - LoL version mapping fallback
    if (data.version) {
      state.version = data.version.split('.').length === 2 ? `${data.version}.1` : data.version;
    }

    // Filter captains from general pool to prevent double-drafting
    const captainPuuids = state.captains.map(c => c.puu_id).filter(Boolean);
    state.poolPlayers = state.allPlayers.filter(p => !captainPuuids.includes(p.puu_id));

    // Build initial teams dynamic list
    initTeams();

    // Render initial view
    updateAppView();

  } catch (error) {
    console.error(error);
    poolContainer.innerHTML = `
      <div class="loading-state" style="color: var(--loss-color)">
        <i data-lucide="alert-triangle" style="width: 48px; height: 48px; margin-bottom: 12px;"></i>
        <p>${error.message}</p>
        <p style="font-size: 12px; color: var(--text-muted); margin-top: 4px;">먼저 venv를 활성화하고 Python crawler(crawler.py)를 실행하여 데이터를 추출하세요.</p>
      </div>
    `;
    lucide.createIcons();
  }
}

// Build teams based on captains list
function initTeams() {
  state.teams = state.captains.map(captain => {
    const initBudget = captain.initial_budget !== undefined ? parseInt(captain.initial_budget) : state.initialBudget;
    return {
      captain: captain,
      roster: [null, null, null, null], // 4 players slot (excluding Captain)
      bids: [0, 0, 0, 0],               // Bids corresponding to the slot
      initialBudget: initBudget,
      budget: initBudget
    };
  });
}

// Bind interactive event listeners
function setupEventListeners() {
  // Search and Filter controls
  const searchInput = document.getElementById("player-search");
  const tierFilter = document.getElementById("tier-filter");

  searchInput.addEventListener("input", (e) => {
    state.filters.search = e.target.value.toLowerCase().trim();
    renderPool();
  });

  tierFilter.addEventListener("change", (e) => {
    state.filters.tier = e.target.value;
    renderPool();
  });

  const positionFilter = document.getElementById("position-filter");
  positionFilter.addEventListener("change", (e) => {
    state.filters.position = e.target.value;
    renderPool();
  });

  const randomPickBtn = document.getElementById("btn-random-pick");
  if (randomPickBtn) {
    randomPickBtn.addEventListener("click", nominateRandomPlayer);
  }

  // Bid Amount direct keyup input synchronization
  const bidAmountInput = document.getElementById("bid-amount");
  bidAmountInput.addEventListener("input", (e) => {
    let val = parseInt(e.target.value) || 0;
    if (val < 0) val = 0;
    state.nominatedBid = val;
  });

  const bidTeamSelect = document.getElementById("bid-team-select");
  if (bidTeamSelect) {
    bidTeamSelect.addEventListener("change", (e) => {
      const teamIndex = parseInt(e.target.value);
      if (!isNaN(teamIndex) && state.teams[teamIndex]) {
        document.getElementById("bid-amount").max = state.teams[teamIndex].budget;
      }
    });
  }

  // Reset and Copy buttons
  document.getElementById("btn-reset").addEventListener("click", resetDraft);
  document.getElementById("btn-export").addEventListener("click", exportTeams);

  // Bidding Confirm & Pass
  document.getElementById("btn-bid-confirm").addEventListener("click", confirmBid);
  document.getElementById("btn-bid-pass").addEventListener("click", passBid);

  // Nominee Chart Tab switch buttons
  document.getElementById("tab-nominee-solo-trend").addEventListener("click", () => switchNomineeChartTab("solo"));
  document.getElementById("tab-nominee-flex-trend").addEventListener("click", () => switchNomineeChartTab("flex"));

  // Modal Close buttons
  document.getElementById("btn-close-modal").addEventListener("click", closeModal);
  document.getElementById("player-modal").addEventListener("click", (e) => {
    if (e.target.id === "player-modal") closeModal();
  });

  // Modal Chart Tab switch buttons
  document.getElementById("tab-solo-trend").addEventListener("click", () => switchModalTab("solo"));
  document.getElementById("tab-flex-trend").addEventListener("click", () => switchModalTab("flex"));
  document.getElementById("tab-season-history").addEventListener("click", () => switchModalTab("season"));
}

// Custom Confirm Modal helper instead of window.confirm
function showConfirm(title, message, onOk) {
  const modal = document.getElementById("confirm-modal");
  document.getElementById("confirm-title").textContent = title;
  document.getElementById("confirm-message").textContent = message;

  const btnOk = document.getElementById("btn-confirm-ok");
  const btnCancel = document.getElementById("btn-confirm-cancel");

  // Clone nodes to easily strip off previous event listeners
  const newBtnOk = btnOk.cloneNode(true);
  const newBtnCancel = btnCancel.cloneNode(true);
  btnOk.parentNode.replaceChild(newBtnOk, btnOk);
  btnCancel.parentNode.replaceChild(newBtnCancel, btnCancel);

  newBtnOk.addEventListener("click", () => {
    modal.classList.remove("active");
    if (onOk) onOk();
  });

  newBtnCancel.addEventListener("click", () => {
    modal.classList.remove("active");
  });

  modal.classList.add("active");
  lucide.createIcons();
}

// Update the full interface
function updateAppView() {
  renderPool();
  renderTeams();
  renderAuctionDesk();
  updateRemainingCount();
  lucide.createIcons();
}

// Get currently filtered pool players (excluding drafted and nominated players)
function getFilteredPoolPlayers() {
  const draftedPuuids = [];
  state.teams.forEach(team => {
    team.roster.forEach(player => {
      if (player) draftedPuuids.push(player.puu_id);
    });
  });

  if (state.nominatedPlayer) {
    draftedPuuids.push(state.nominatedPlayer.puu_id);
  }

  return state.poolPlayers.filter(player => {
    const isDrafted = draftedPuuids.includes(player.puu_id);
    const matchesSearch = player.riot_id_name.toLowerCase().includes(state.filters.search);

    let matchesTier = true;
    if (state.filters.tier !== "ALL") {
      const playerTier = player.tier_info?.solo?.tier || "UNRANKED";
      matchesTier = playerTier.toUpperCase() === state.filters.tier;
    }

    let matchesPosition = true;
    if (state.filters.position && state.filters.position !== "ALL") {
      const playerPos = player.position || "";
      matchesPosition = playerPos.includes(state.filters.position);
    }

    return !isDrafted && matchesSearch && matchesTier && matchesPosition;
  });
}

// Nominate a random player from the filtered pool
function nominateRandomPlayer() {
  const filtered = getFilteredPoolPlayers();

  if (filtered.length === 0) {
    alert("경매 풀에 남은 선수가 없거나 필터 조건에 맞는 선수가 없습니다.");
    return;
  }

  const executePick = () => {
    const randomIndex = Math.floor(Math.random() * filtered.length);
    const randomPlayer = filtered[randomIndex];
    nominatePlayer(randomPlayer.puu_id);
  };

  if (state.nominatedPlayer) {
    showConfirm(
      "선수 교체 확인", 
      "이미 경매대에 올라와 있는 선수가 있습니다. 다른 선수를 랜덤 지목하시겠습니까?", 
      executePick
    );
  } else {
    executePick();
  }
}

// Render available players list
function renderPool() {
  const poolContainer = document.getElementById("player-pool-container");
  poolContainer.innerHTML = "";

  const filtered = getFilteredPoolPlayers();

  document.getElementById("pool-total").textContent = filtered.length;

  if (filtered.length === 0) {
    poolContainer.innerHTML = `
      <div class="loading-state">
        <p>조건에 맞는 플레이어가 없습니다.</p>
      </div>
    `;
    return;
  }

  filtered.forEach(player => {
    const solo = player.tier_info?.solo || { tier: "UNRANKED" };
    const tierName = solo.tier || "UNRANKED";
    const tierColor = TIER_COLORS[tierName.toUpperCase()] || TIER_COLORS.UNRANKED;
    const profileIcon = `https://ddragon.leagueoflegends.com/cdn/${state.version}/img/profileicon/${player.profile_icon_id || 29}.png`;

    const card = document.createElement("div");
    card.className = "player-card";

    // HTML structure for card
    let champsHtml = "";
    if (player.top_champions && player.top_champions.length > 0) {
      player.top_champions.slice(0, 3).forEach(c => {
        champsHtml += `<img class="most-champ-img" src="https://ddragon.leagueoflegends.com/cdn/${state.version}/img/champion/${c.name_en}.png" title="${c.name_kr} (승률: ${c.win_rate}%)" onerror="this.src='https://ddragon.leagueoflegends.com/cdn/${state.version}/img/champion/Garen.png'">`;
      });
    } else {
      champsHtml = `<span class="no-most-label">기록 없음</span>`;
    }

    card.innerHTML = `
      <div class="card-header" onclick="openPlayerModal('${player.puu_id}')">
        <div class="card-avatar-wrap">
          <img src="${profileIcon}" alt="summoner icon" onerror="this.src='https://ddragon.leagueoflegends.com/cdn/${state.version}/img/profileicon/29.png'">
          <span class="card-level-badge">Lv.${player.level || 1}</span>
        </div>
        <div class="card-profile-text">
          <span class="card-summoner-name">
            ${player.riot_id_name}
            ${player.position ? `<span class="position-badge">${player.position}</span>` : ''}
          </span>
          <span class="card-summoner-tag">#${player.riot_id_tag_line}</span>
          <div class="card-tier-info">
            <span class="tier-bullet" style="background-color: ${tierColor}; box-shadow: 0 0 8px ${tierColor}"></span>
            <span class="tier-text" style="color: ${tierColor}">${tierName} ${solo.division || ""}</span>
          </div>
        </div>
      </div>
      <div class="card-footer">
        <div class="card-most-played">
          ${champsHtml}
        </div>
        <button class="card-pick-btn" onclick="nominatePlayer('${player.puu_id}')">경매 올리기</button>
      </div>
    `;

    poolContainer.appendChild(card);
  });
}

// Render dynamic team columns
function renderTeams() {
  const container = document.getElementById("teams-columns-container");
  container.innerHTML = "";

  if (state.teams.length === 0) {
    container.innerHTML = `
      <div class="loading-state">
        <p>배정된 팀장 정보가 없습니다.</p>
      </div>
    `;
    return;
  }

  state.teams.forEach((team, teamIndex) => {
    const captain = team.captain;
    const profileIcon = `https://ddragon.leagueoflegends.com/cdn/${state.version}/img/profileicon/${captain.profile_icon_id || 29}.png`;
    const budgetPercent = (team.budget / team.initialBudget) * 100;

    // Choose dynamic color for budget bar based on remaining points
    let budgetColor = "var(--win-color)"; // Green
    if (budgetPercent < 30) {
      budgetColor = "var(--loss-color)"; // Red
    } else if (budgetPercent < 60) {
      budgetColor = "var(--gold)"; // Yellow
    }

    const card = document.createElement("div");
    card.className = "team-auction-card";

    // Build slots HTML
    let slotsHtml = "";
    for (let slotIndex = 0; slotIndex < 4; slotIndex++) {
      const player = team.roster[slotIndex];
      if (player) {
        const solo = player.tier_info?.solo || { tier: "UNRANKED" };
        const tierName = solo.tier || "UNRANKED";
        const tierColor = TIER_COLORS[tierName.toUpperCase()] || TIER_COLORS.UNRANKED;
        const playerIcon = `https://ddragon.leagueoflegends.com/cdn/${state.version}/img/profileicon/${player.profile_icon_id || 29}.png`;
        const bidPrice = team.bids[slotIndex];

        slotsHtml += `
          <div class="roster-slot filled">
            <div class="roster-player-profile" onclick="openPlayerModal('${player.puu_id}')" style="cursor:pointer">
              <img src="${playerIcon}" alt="icon" onerror="this.src='https://ddragon.leagueoflegends.com/cdn/${state.version}/img/profileicon/29.png'">
              <div style="display:flex; flex-direction:column;">
                <span class="roster-player-name">
                  ${player.riot_id_name}
                  ${player.position ? `<span class="position-badge mini">${player.position}</span>` : ''}
                </span>
                <span class="roster-player-tier" style="color: ${tierColor}">${tierName} ${solo.division || ""}</span>
              </div>
            </div>
            <span class="roster-price-badge">${bidPrice} pt</span>
            <span class="roster-release-btn" onclick="releasePlayer(${teamIndex}, ${slotIndex})" title="낙찰 해제">
              <i data-lucide="x" style="width:10px; height:10px;"></i>
            </span>
          </div>
        `;
      } else {
        slotsHtml += `
          <div class="roster-slot empty">
            선택 대기 중
          </div>
        `;
      }
    }

    card.innerHTML = `
      <div class="team-card-header">
        <div class="team-captain-info" onclick="openPlayerModal('${captain.puu_id}')">
          <img src="${profileIcon}" alt="captain icon" onerror="this.src='https://ddragon.leagueoflegends.com/cdn/${state.version}/img/profileicon/29.png'">
          <div class="team-name-wrap">
            <span class="team-captain-name">
              ${captain.riot_id_name} 팀
              ${captain.position ? `<span class="position-badge mini">${captain.position}</span>` : ''}
            </span>
            <span class="team-captain-lvl">Lv.${captain.level || 1} • 팀장</span>
          </div>
        </div>
        <div class="team-budget-info">
          <div class="budget-stats">
            <span>남은 예산</span>
            <span class="pt-value">${team.budget} pt</span>
          </div>
          <div class="budget-bar-container">
            <div class="budget-bar-fill" style="width: ${budgetPercent}%; background-color: ${budgetColor}"></div>
          </div>
        </div>
      </div>
      <div class="team-roster-list">
        ${slotsHtml}
      </div>
    `;

    container.appendChild(card);
  });
}

// Render the central Auction Desk Stage
function renderAuctionDesk() {
  const placeholder = document.getElementById("nominee-placeholder");
  const nomineeCard = document.getElementById("nominee-card");
  const biddingBar = document.getElementById("bidding-controls-bar");

  if (!state.nominatedPlayer) {
    placeholder.classList.remove("hidden");
    nomineeCard.classList.add("hidden");
    biddingBar.classList.add("hidden");
    if (nomineeChartInstance) {
      nomineeChartInstance.destroy();
      nomineeChartInstance = null;
    }
    return;
  }

  placeholder.classList.add("hidden");
  nomineeCard.classList.remove("hidden");
  biddingBar.classList.remove("hidden");

  const player = state.nominatedPlayer;
  const profileIcon = `https://ddragon.leagueoflegends.com/cdn/${state.version}/img/profileicon/${player.profile_icon_id || 29}.png`;

  // Fill basic nominee profile
  document.getElementById("nominee-profile-icon").src = profileIcon;
  document.getElementById("nominee-profile-level").textContent = `Lv.${player.level || 1}`;
  document.getElementById("nominee-summoner-name").textContent = player.riot_id_name;
  document.getElementById("nominee-summoner-tag").textContent = `#${player.riot_id_tag_line}`;

  const nomineePos = document.getElementById("nominee-position");
  if (nomineePos) {
    nomineePos.textContent = player.position || "미지정";
    nomineePos.style.display = player.position ? "inline-block" : "none";
  }

  const getCleanTier = (tierObj) => {
    const tier = (tierObj?.tier || "UNRANKED").toUpperCase();
    if (tier === "UNRANKED") return "UNRANKED";
    const div = tierObj?.division ? ` ${tierObj.division}` : "";
    return `${tier}${div}`;
  };

  const getCleanColor = (tierObj) => {
    const tier = (tierObj?.tier || "UNRANKED").toUpperCase();
    return TIER_COLORS[tier] || TIER_COLORS.UNRANKED;
  };

  const getDetailText = (tierObj) => {
    const tier = (tierObj?.tier || "UNRANKED").toUpperCase();
    if (tier === "UNRANKED") return "UNRANKED";
    const div = tierObj?.division ? ` ${tierObj.division}` : "";
    const lp = tierObj?.lp || 0;
    return `${tier}${div} (${lp} LP)`;
  };

  const solo = player.tier_info?.solo || { tier: "UNRANKED", division: 0, lp: 0, wins: 0, losses: 0, win_rate: 0 };
  const flex = player.tier_info?.flex || { tier: "UNRANKED", division: 0, lp: 0, wins: 0, losses: 0, win_rate: 0 };
  const soloText = getCleanTier(player.tier_info?.solo);
  const flexText = getCleanTier(player.tier_info?.flex);
  const soloColor = getCleanColor(player.tier_info?.solo);
  const flexColor = getCleanColor(player.tier_info?.flex);

  // Tier labels (Solo & Flex)
  const soloTierEl = document.getElementById("nominee-solo-tier");
  const flexTierEl = document.getElementById("nominee-flex-tier");
  if (soloTierEl) {
    soloTierEl.textContent = `솔랭: ${soloText}`;
    soloTierEl.style.color = soloColor;
  }
  if (flexTierEl) {
    flexTierEl.textContent = `자랭: ${flexText}`;
    flexTierEl.style.color = flexColor;
  }

  // Detail Ranks
  document.getElementById("nominee-solo-detail").textContent = getDetailText(player.tier_info?.solo);
  document.getElementById("nominee-solo-wl").textContent = `${solo.wins}승 ${solo.losses}패 (${solo.win_rate}%)`;
  document.getElementById("nominee-flex-detail").textContent = getDetailText(player.tier_info?.flex);
  document.getElementById("nominee-flex-wl").textContent = `${flex.wins}승 ${flex.losses}패 (${flex.win_rate}%)`;

  // Render LP Chart on Nominee Card
  currentNomineeChartTab = "solo";
  renderNomineeChart(player);

  // Render nominee champions (show all crawled top champions on the desk card)
  const champsContainer = document.getElementById("nominee-top-champs");
  champsContainer.innerHTML = "";
  if (player.top_champions && player.top_champions.length > 0) {
    player.top_champions.forEach(c => {
      const card = document.createElement("div");
      card.className = "nominee-champ-icon-card";
      card.innerHTML = `
        <img src="https://ddragon.leagueoflegends.com/cdn/${state.version}/img/champion/${c.name_en}.png" alt="${c.name_kr}" onerror="this.src='https://ddragon.leagueoflegends.com/cdn/${state.version}/img/champion/Garen.png'">
        <span class="nominee-champ-name" title="${c.name_kr}">${c.name_kr}</span>
        <span class="nominee-champ-games">${c.games}판</span>
        <span class="nominee-champ-wr" style="color: ${c.win_rate >= 50 ? 'var(--win-color)' : 'var(--text-muted)'}">${c.win_rate}%</span>
      `;
      champsContainer.appendChild(card);
    });
  } else {
    champsContainer.innerHTML = `<span class="no-most-label" style="grid-column: 1/-1;">챔피언 정보가 없습니다.</span>`;
  }

  // Render nominee season history
  const seasonContainer = document.getElementById("nominee-season-history");
  seasonContainer.innerHTML = "";
  if (player.season_history && player.season_history.length > 0) {
    player.season_history.forEach(h => {
      const record = formatSeasonRecord(h);
      const tierColor = TIER_COLORS[record.tier] || TIER_COLORS.UNRANKED;
      const item = document.createElement("div");
      item.className = "nominee-season-item";
      item.innerHTML = `
        <span class="nominee-season-name">${record.season}</span>
        <span class="nominee-season-rank" style="color: ${tierColor}">${record.rank}</span>
      `;
      seasonContainer.appendChild(item);
    });
  } else {
    seasonContainer.innerHTML = `<span class="no-most-label">시즌 기록이 없습니다.</span>`;
  }

  // Render nominee recent matches
  const matchesContainer = document.getElementById("nominee-matches");
  matchesContainer.innerHTML = "";
  if (player.recent_matches && player.recent_matches.length > 0) {
    player.recent_matches.slice(0, 10).forEach(m => {
      const item = document.createElement("div");
      item.className = `nominee-match-item ${m.win ? 'win' : 'loss'}`;

      const deaths = m.deaths === 0 ? 1 : m.deaths;
      const kda = ((m.kills + m.assists) / deaths).toFixed(2);

      item.innerHTML = `
        <div class="nominee-match-champ">
          <img src="https://ddragon.leagueoflegends.com/cdn/${state.version}/img/champion/${m.champion_name_en}.png" alt="${m.champion_name_kr}" onerror="this.src='https://ddragon.leagueoflegends.com/cdn/${state.version}/img/champion/Garen.png'">
          <span class="nominee-match-champ-name">${m.champion_name_kr}</span>
        </div>
        <span class="nominee-match-result">${m.win ? '승리' : '패배'}</span>
        <span class="nominee-match-kda">${m.kills}/${m.deaths}/${m.assists} (${kda})</span>
      `;
      matchesContainer.appendChild(item);
    });
  } else {
    matchesContainer.innerHTML = `<span class="no-most-label">최근 전적 기록이 없습니다.</span>`;
  }

  // Populate bidding Captain selection dropdown
  const select = document.getElementById("bid-team-select");
  select.innerHTML = "";
  let firstValidIndex = -1;
  state.teams.forEach((team, index) => {
    // Disable captain team if their roster is already full (4 members drafted)
    const isFull = team.roster.filter(Boolean).length >= 4;
    const option = document.createElement("option");
    option.value = index;
    option.disabled = isFull;
    option.textContent = `${team.captain.riot_id_name} (${team.budget} pt)${isFull ? ' [풀]' : ''}`;
    select.appendChild(option);
    if (!isFull && firstValidIndex === -1) {
      firstValidIndex = index;
    }
  });

  // Set default selection to first non-full team
  if (firstValidIndex !== -1) {
    select.value = firstValidIndex;
    document.getElementById("bid-amount").max = state.teams[firstValidIndex].budget;
  }

  // Sync Bidding Bid amount input
  document.getElementById("bid-amount").value = state.nominatedBid;
}

// Nominate player to stage
function nominatePlayer(puuid) {
  const player = state.poolPlayers.find(p => p.puu_id === puuid);
  if (!player) return;

  state.nominatedPlayer = player;
  state.nominatedBid = 50; // Initial bid default

  updateAppView();

  // Smooth scroll up to the Auction Stage
  document.getElementById("auction-desk").scrollIntoView({ behavior: "smooth" });
}

// Adjust Nominated Bid
function adjustBid(amount) {
  state.nominatedBid = Math.max(0, state.nominatedBid + amount);
  document.getElementById("bid-amount").value = state.nominatedBid;
}
window.adjustBid = adjustBid; // Expose globally for inline onclick

// Confirm Bid and assign to target team
function confirmBid() {
  if (!state.nominatedPlayer) return;

  const select = document.getElementById("bid-team-select");
  const teamIndex = parseInt(select.value);
  if (isNaN(teamIndex) || teamIndex < 0 || teamIndex >= state.teams.length) {
    alert("낙찰할 팀장을 선택해주세요.");
    return;
  }

  const team = state.teams[teamIndex];
  const bidAmount = parseInt(document.getElementById("bid-amount").value) || 0;

  // Validations
  if (bidAmount < 0) {
    alert("낙찰 금액은 0pt 이상이어야 합니다.");
    return;
  }

  if (bidAmount > team.budget) {
    alert(`예산 초과! ${team.captain.riot_id_name} 팀의 남은 예산은 ${team.budget}pt 입니다. (입찰가: ${bidAmount}pt)`);
    return;
  }

  const emptyIndex = team.roster.findIndex(slot => slot === null);
  if (emptyIndex === -1) {
    alert(`${team.captain.riot_id_name} 팀의 팀원이 모두 가득 찼습니다! (최대 4명)`);
    return;
  }

  // Deduct budget & Assign player
  team.budget -= bidAmount;
  team.roster[emptyIndex] = state.nominatedPlayer;
  team.bids[emptyIndex] = bidAmount;

  // Clear auction nominee state
  state.nominatedPlayer = null;
  state.nominatedBid = 50;

  updateAppView();
}

// Pass bid (유찰)
function passBid() {
  if (!state.nominatedPlayer) return;

  showConfirm("유찰 처리", `${state.nominatedPlayer.riot_id_name} 선수를 유찰 처리하시겠습니까?`, () => {
    state.nominatedPlayer = null;
    state.nominatedBid = 50;

    updateAppView();
  });
}

// Release player from roster back to pool
function releasePlayer(teamIndex, rosterIndex) {
  const team = state.teams[teamIndex];
  if (!team) return;

  const player = team.roster[rosterIndex];
  if (!player) return;

  showConfirm("방출 확인", `${player.riot_id_name} 선수를 ${team.captain.riot_id_name} 팀에서 방출하시겠습니까? (낙찰 포인트 환불)`, () => {
    const refund = team.bids[rosterIndex];
    team.budget += refund;
    team.roster[rosterIndex] = null;
    team.bids[rosterIndex] = 0;

    updateAppView();
  });
}
window.releasePlayer = releasePlayer; // Expose globally for inline onclick

// Update turn/remaining counter displays
function updateRemainingCount() {
  // Collect all drafted players
  const draftedPuuids = [];
  state.teams.forEach(team => {
    team.roster.forEach(player => {
      if (player) draftedPuuids.push(player.puu_id);
    });
  });
  if (state.nominatedPlayer) {
    draftedPuuids.push(state.nominatedPlayer.puu_id);
  }

  const captainPuuids = state.captains.map(c => c.puu_id).filter(Boolean);
  const remaining = state.allPlayers.filter(p => !draftedPuuids.includes(p.puu_id) && !captainPuuids.includes(p.puu_id)).length;

  const remainingEl = document.getElementById("remaining-count");
  if (remainingEl) {
    remainingEl.textContent = `${remaining}명`;
  }

  // No pulse indicator update required
}

// Reset entire draft state
function resetDraft() {
  showConfirm("초기화 확인", "모든 경매 진행 상황을 초기화하시겠습니까? (예산 및 스쿼드가 리셋됩니다)", () => {
    initTeams();
    state.nominatedPlayer = null;
    state.nominatedBid = 50;

    updateAppView();
  });
}

// Open detailed stats modal
function openPlayerModal(puuid) {
  // Find player details in either pool or captains or roster
  let player = state.allPlayers.find(p => p.puu_id === puuid) || state.captains.find(c => c.puu_id === puuid);

  if (!player) {
    // Check inside roster lists
    state.teams.forEach(team => {
      const found = team.roster.find(p => p && p.puu_id === puuid);
      if (found) player = found;
    });
  }

  if (!player) return;

  const modal = document.getElementById("player-modal");

  // Fill text info
  document.getElementById("modal-summoner-name").textContent = player.riot_id_name;
  document.getElementById("modal-summoner-tag").textContent = `#${player.riot_id_tag_line}`;
  document.getElementById("modal-profile-level").textContent = player.level || "--";

  const modalPos = document.getElementById("modal-position");
  if (modalPos) {
    modalPos.textContent = player.position || "미지정";
    modalPos.style.display = player.position ? "inline-block" : "none";
  }

  const iconImg = document.getElementById("modal-profile-icon");
  iconImg.src = `https://ddragon.leagueoflegends.com/cdn/${state.version}/img/profileicon/${player.profile_icon_id || 29}.png`;

  // Process Rank Info (Solo / Flex)
  const solo = player.tier_info?.solo || { tier: "UNRANKED", division: 0, lp: 0, wins: 0, losses: 0, win_rate: 0 };
  const flex = player.tier_info?.flex || { tier: "UNRANKED", division: 0, lp: 0, wins: 0, losses: 0, win_rate: 0 };

  // Render Solo Rank Box
  document.getElementById("modal-solo-tier").textContent = `${solo.tier} ${solo.division || ""}`;
  document.getElementById("modal-solo-tier").style.color = TIER_COLORS[solo.tier.toUpperCase()] || TIER_COLORS.UNRANKED;
  document.getElementById("modal-solo-lp").textContent = `${solo.lp} LP`;
  document.getElementById("modal-solo-wl").textContent = `${solo.wins}승 ${solo.losses}패 (승률 ${solo.win_rate}%)`;

  // Set Solo Badge emblem text
  const soloBadge = document.getElementById("modal-solo-tier-icon");
  soloBadge.textContent = solo.tier.substring(0, 3) || "UNR";
  soloBadge.style.borderColor = TIER_COLORS[solo.tier.toUpperCase()] || TIER_COLORS.UNRANKED;
  soloBadge.style.color = TIER_COLORS[solo.tier.toUpperCase()] || TIER_COLORS.UNRANKED;

  // Render Flex Rank Box
  document.getElementById("modal-flex-tier").textContent = `${flex.tier} ${flex.division || ""}`;
  document.getElementById("modal-flex-tier").style.color = TIER_COLORS[flex.tier.toUpperCase()] || TIER_COLORS.UNRANKED;
  document.getElementById("modal-flex-lp").textContent = `${flex.lp} LP`;
  document.getElementById("modal-flex-wl").textContent = `${flex.wins}승 ${flex.losses}패 (승률 ${flex.win_rate}%)`;

  const flexBadge = document.getElementById("modal-flex-tier-icon");
  flexBadge.textContent = flex.tier.substring(0, 3) || "UNR";
  flexBadge.style.borderColor = TIER_COLORS[flex.tier.toUpperCase()] || TIER_COLORS.UNRANKED;
  flexBadge.style.color = TIER_COLORS[flex.tier.toUpperCase()] || TIER_COLORS.UNRANKED;

  // Render trend charts in modal
  currentModalPlayer = player;
  currentModalTab = "solo";

  const btnSolo = document.getElementById("tab-solo-trend");
  const btnFlex = document.getElementById("tab-flex-trend");
  const btnSeason = document.getElementById("tab-season-history");
  if (btnSolo) btnSolo.classList.add("active");
  if (btnFlex) btnFlex.classList.remove("active");
  if (btnSeason) btnSeason.classList.remove("active");

  renderModalChart(player);

  // Render Top Played Champions
  const champsContainer = document.getElementById("modal-top-champs");
  champsContainer.innerHTML = "";

  if (player.top_champions && player.top_champions.length > 0) {
    player.top_champions.forEach(c => {
      const champCard = document.createElement("div");
      champCard.className = "top-champ-card";

      const champImgUrl = `https://ddragon.leagueoflegends.com/cdn/${state.version}/img/champion/${c.name_en}.png`;
      const winRateColor = c.win_rate >= 60 ? "var(--challenger)" : (c.win_rate >= 50 ? "var(--win-color)" : "var(--text-secondary)");
      const kdaColor = c.kda >= 4 ? "var(--gold)" : (c.kda >= 2.5 ? "var(--win-color)" : "var(--text-muted)");

      champCard.innerHTML = `
        <img src="${champImgUrl}" alt="${c.name_kr}" onerror="this.src='https://ddragon.leagueoflegends.com/cdn/${state.version}/img/champion/Garen.png'">
        <span class="top-champ-name">${c.name_kr}</span>
        <span class="top-champ-games">${c.games}게임</span>
        <span class="top-champ-wr" style="color: ${winRateColor}">${c.win_rate}%</span>
        <span class="top-champ-kda" style="color: ${kdaColor}">${c.kda.toFixed(2)} KDA</span>
      `;
      champsContainer.appendChild(champCard);
    });
  } else {
    champsContainer.innerHTML = `<div class="loading-state"><p>최근 플레이한 챔피언 기록이 없습니다.</p></div>`;
  }

  // Render Recent Matches
  const matchesContainer = document.getElementById("modal-match-history");
  matchesContainer.innerHTML = "";

  if (player.recent_matches && player.recent_matches.length > 0) {
    player.recent_matches.forEach(m => {
      const matchRow = document.createElement("div");
      matchRow.className = `match-item ${m.win ? 'win' : 'loss'}`;

      const champImgUrl = `https://ddragon.leagueoflegends.com/cdn/${state.version}/img/champion/${m.champion_name_en}.png`;
      const resultText = m.win ? "승리" : "패배";

      const durationMin = Math.floor(m.duration / 60);
      const durationSec = m.duration % 60;

      // Relative time formatting
      let timeText = "";
      const diffMs = Date.now() - m.timestamp;
      const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
      const diffDays = Math.floor(diffHours / 24);

      if (diffDays > 0) {
        timeText = `${diffDays}일 전`;
      } else if (diffHours > 0) {
        timeText = `${diffHours}시간 전`;
      } else {
        timeText = "최근";
      }

      const deaths = m.deaths === 0 ? 1 : m.deaths;
      const kdaRatio = ((m.kills + m.assists) / deaths).toFixed(2);

      matchRow.innerHTML = `
        <div class="match-champion-info">
          <div class="match-champ-img-wrap">
            <img src="${champImgUrl}" alt="${m.champion_name_kr}" onerror="this.src='https://ddragon.leagueoflegends.com/cdn/${state.version}/img/champion/Garen.png'">
          </div>
          <div class="match-champ-text">
            <span class="match-champ-name">${m.champion_name_kr}</span>
            <span class="match-queue-type">${m.queue_type}</span>
          </div>
        </div>
        <div class="match-result-badge">${resultText}</div>
        <div class="match-kda">
          <div class="match-kda-numbers">${m.kills} / <span style="color:var(--loss-color)">${m.deaths}</span> / ${m.assists}</div>
          <div class="match-kda-ratio">${kdaRatio} KDA</div>
        </div>
        <div class="match-meta-info">
          <span>${durationMin}분 ${durationSec}초</span>
          <span>${timeText}</span>
        </div>
      `;
      matchesContainer.appendChild(matchRow);
    });
  } else {
    matchesContainer.innerHTML = `<div class="loading-state"><p>최근 경기 기록이 없습니다.</p></div>`;
  }

  // Show Modal
  modal.classList.add("active");
  lucide.createIcons();
}
window.openPlayerModal = openPlayerModal; // Expose globally for inline onclick
window.nominatePlayer = nominatePlayer; // Expose globally for inline onclick

// Close Modal
function closeModal() {
  document.getElementById("player-modal").classList.remove("active");
  currentModalPlayer = null;
  if (modalChartInstance) {
    modalChartInstance.destroy();
    modalChartInstance = null;
  }
}

// Export Team Draft Results to Clipboard
function exportTeams() {
  let output = `🎮 LOL 내전 경매 드래프트 결과 🎮\n\n`;

  state.teams.forEach(team => {
    const captainName = team.captain.riot_id_name;
    const spentBudget = team.initialBudget - team.budget;
    output += `👑 ${captainName} 팀 [사용 포인트: ${spentBudget} pt / 남은 포인트: ${team.budget} pt]\n`;

    // List roster slots
    team.roster.forEach((player, i) => {
      const slotNum = i + 1;
      if (player) {
        const solo = player.tier_info?.solo || { tier: "UNRANKED" };
        const price = team.bids[i];
        output += `  Slot ${slotNum}: ${player.riot_id_name} (${solo.tier} ${solo.division || ""}) - [${price} pt]\n`;
      } else {
        output += `  Slot ${slotNum}: (비어있음)\n`;
      }
    });
    output += `\n`;
  });

  output += `Created by 링크드`;

  // Show Export Modal
  const modal = document.getElementById("export-modal");
  const textarea = document.getElementById("export-textarea");
  textarea.value = output;
  modal.classList.add("active");
  lucide.createIcons();

  // Try Copy to Clipboard
  navigator.clipboard.writeText(output).then(() => {
    // Show Toast Notification
    const toast = document.getElementById("toast-message");
    toast.classList.add("show");
    setTimeout(() => {
      toast.classList.remove("show");
    }, 2500);
  }).catch(err => {
    console.error("클립보드 복사 실패:", err);
  });
}
