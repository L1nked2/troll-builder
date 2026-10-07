/* Landing page, temporary participant state, and manual record refresh controls. */
const recordsClient = RecordClient.createClient();
let updatingAll = false;
let activeUpdates = 0;
let hasSession = false;
let nextPlayerId = 0;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function createIcons() {
  if (window.lucide) window.lucide.createIcons();
}

function addSetupRow(role, entry = {}) {
  const captain = role === "captain";
  const container = document.getElementById(captain ? "setup-captains" : "setup-players");
  const row = document.createElement("div");
  row.className = `setup-row${captain ? " captain-row" : ""}`;
  row.innerHTML = `<span class="setup-row-number"></span>
    <label class="setup-id-label"><span>Riot ID</span><input class="setup-riot-id" type="text" placeholder="닉네임#KR1" maxlength="100" autocomplete="off" spellcheck="false"></label>
    <label><span>주 포지션</span><input class="setup-position" type="text" placeholder="예: 미드, 정글" maxlength="60" autocomplete="off"></label>
    ${captain ? '<label class="setup-row-budget"><span>예산 (pt)</span><input class="setup-personal-budget" type="number" min="0" max="1000000" step="1" placeholder="기본 예산"></label>' : ""}
    <button type="button" class="setup-remove" title="행 삭제">×</button>`;
  row.querySelector(".setup-riot-id").value = entry.riot_id_name ? `${entry.riot_id_name}#${entry.riot_id_tag_line}` : "";
  row.querySelector(".setup-position").value = entry.position || "";
  if (captain) row.querySelector(".setup-personal-budget").value = entry.initial_budget ?? "";
  row.querySelector(".setup-remove").addEventListener("click", () => { row.remove(); updateSetupSummary(); });
  row.addEventListener("input", updateSetupSummary);
  container.appendChild(row);
  updateSetupSummary();
  return row;
}

function updateSetupSummary() {
  const counts = [];
  for (const [role, containerId] of [["팀장", "setup-captains"], ["참가자", "setup-players"]]) {
    const rows = [...document.getElementById(containerId).children];
    rows.forEach((row, index) => {
      row.querySelector(".setup-row-number").textContent = String(index + 1).padStart(2, "0");
      row.querySelector(".setup-riot-id").setAttribute("aria-label", `${role} ${index + 1} Riot ID`);
      row.querySelector(".setup-position").setAttribute("aria-label", `${role} ${index + 1} 포지션`);
      row.querySelector(".setup-personal-budget")?.setAttribute("aria-label", `${role} ${index + 1} 예산`);
      row.querySelector(".setup-remove").setAttribute("aria-label", `${role} ${index + 1} 삭제`);
    });
    counts.push(rows.filter(row => row.querySelector(".setup-riot-id").value.trim()).length);
  }
  document.getElementById("setup-captain-count").textContent = `${counts[0]}명`;
  document.getElementById("setup-player-count").textContent = `${counts[1]}명`;
  document.getElementById("setup-summary").textContent = `${counts[0]}개 팀 · 경매 참가자 ${counts[1]}명`;
}

function readSetupEntries(containerId, initialBudget, seen) {
  const entries = [];
  const label = containerId === "setup-captains" ? "팀장" : "참가자";
  [...document.getElementById(containerId).children].forEach((row, index) => {
    const input = row.querySelector(".setup-riot-id");
    const position = row.querySelector(".setup-position").value.trim();
    const budgetInput = row.querySelector(".setup-personal-budget");
    if (!input.value.trim() && !position && !budgetInput?.value) return;
    try {
      const entry = { ...RecordClient.parseRiotId(input.value), position };
      const key = RecordClient.playerKey(entry);
      if (seen.has(key)) throw new Error("동일한 Riot ID가 이미 등록되어 있습니다. 팀장과 참가자는 중복 등록할 수 없습니다.");
      seen.add(key);
      if (budgetInput) entry.initial_budget = RecordClient.parseBudget(budgetInput.value, initialBudget);
      entries.push(entry);
    } catch (error) {
      input.focus();
      throw new Error(`${label} ${index + 1}: ${error.message}`);
    }
  });
  return entries;
}

function startSession(event) {
  event.preventDefault();
  const errorEl = document.getElementById("setup-error");
  errorEl.hidden = true;
  try {
    const initialBudget = RecordClient.parseBudget(document.getElementById("setup-budget").value);
    const seen = new Set();
    const captains = readSetupEntries("setup-captains", initialBudget, seen);
    const players = readSetupEntries("setup-players", initialBudget, seen);
    if (!captains.length || !players.length) throw new Error("팀장과 참가자를 각각 한 명 이상 입력해주세요.");
    const previous = new Map([...state.captains, ...state.allPlayers].map(player => [RecordClient.playerKey(player), player]));
    const build = entry => {
      const old = previous.get(RecordClient.playerKey(entry));
      if (old) {
        const player = { ...old, ...entry };
        if (entry.initial_budget === undefined) delete player.initial_budget;
        return player;
      }
      return RecordClient.makePlayer(entry, `player-${++nextPlayerId}`);
    };
    state.initialBudget = initialBudget;
    state.captains = captains.map(build);
    state.allPlayers = players.map(build);
    state.poolPlayers = [...state.allPlayers];
    state.nominatedPlayer = null;
    state.nominatedBid = 50;
    state.filters = { search: "", tier: "ALL", position: "ALL" };
    document.getElementById("player-search").value = "";
    document.getElementById("tier-filter").value = "ALL";
    document.getElementById("position-filter").value = "ALL";
    closeModal();
    initTeams();
    hasSession = true;
    document.getElementById("setup-page").hidden = true;
    document.getElementById("auction-page").hidden = false;
    document.getElementById("update-progress").textContent = "모든 유저 업데이트 또는 각 유저의 새로고침 버튼으로 전적을 조회하세요.";
    updateAppView();
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (error) {
    errorEl.textContent = error.message;
    errorEl.hidden = false;
  }
}

function editParticipants() {
  if (activeUpdates || updatingAll) return;
  document.getElementById("setup-captains").replaceChildren();
  document.getElementById("setup-players").replaceChildren();
  state.captains.forEach(entry => addSetupRow("captain", entry));
  state.allPlayers.forEach(entry => addSetupRow("player", entry));
  document.getElementById("setup-budget").value = state.initialBudget;
  document.getElementById("setup-error").hidden = true;
  document.getElementById("setup-edit-notice").hidden = false;
  document.getElementById("btn-cancel-setup").hidden = false;
  document.getElementById("auction-page").hidden = true;
  document.getElementById("setup-page").hidden = false;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function setupSession() {
  for (let i = 0; i < 2; i++) addSetupRow("captain");
  for (let i = 0; i < 4; i++) addSetupRow("player");
  document.getElementById("btn-add-captain").addEventListener("click", () => addSetupRow("captain").querySelector("input").focus());
  document.getElementById("btn-add-player").addEventListener("click", () => addSetupRow("player").querySelector("input").focus());
  document.getElementById("setup-form").addEventListener("submit", startSession);
  document.getElementById("btn-cancel-setup").addEventListener("click", () => {
    document.getElementById("setup-page").hidden = true;
    document.getElementById("auction-page").hidden = false;
  });
  document.getElementById("btn-edit-participants").addEventListener("click", editParticipants);
  document.getElementById("btn-update-all").addEventListener("click", updateAllPlayers);
  document.getElementById("btn-modal-refresh").addEventListener("click", () => {
    if (currentModalPlayer) refreshPlayer(currentModalPlayer.client_id);
  });
  document.getElementById("auction-page").addEventListener("click", event => {
    const button = event.target.closest("[data-refresh-player]");
    if (button && !button.disabled) refreshPlayer(button.dataset.refreshPlayer);
  });
  createIcons();
}

function recordStatusText(player) {
  const last = player.updated_at ? new Date(player.updated_at).toLocaleTimeString("ko-KR", { hour12: false }) : "";
  if (player.record_status === "loading") return "전적 조회 중…";
  if (player.record_status === "error") return `${player.record_error}${last ? ` (기존 ${last} 조회 결과 유지)` : ""}`;
  if (last) return `${last} 조회${player.record_warning ? ` · ${player.record_warning}` : ""}`;
  return "전적 미조회";
}

function refreshButton(player, compact = false) {
  const disabled = activeUpdates > 0 || updatingAll;
  const title = `${player.riot_id_name}#${player.riot_id_tag_line} 전적 새로고침`;
  return `<button type="button" class="record-refresh${compact ? " compact" : ""}" data-refresh-player="${player.client_id}" ${disabled ? "disabled" : ""} title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}"><i data-lucide="refresh-cw"></i>${compact ? "" : " 새로고침"}</button>`;
}

function renderParticipantRecords() {
  const container = document.getElementById("participant-records");
  container.replaceChildren();
  for (const [players, role] of [[state.captains, "팀장"], [state.allPlayers, "참가자"]]) {
    players.forEach(player => {
      const row = document.createElement("div");
      row.className = `participant-record ${player.record_status}`;
      row.innerHTML = `<span class="participant-role${role === "팀장" ? " captain" : ""}">${role}</span><div class="participant-record-info"><button type="button" class="participant-name"></button><p class="participant-status"></p></div>${refreshButton(player)}`;
      const name = row.querySelector(".participant-name");
      name.textContent = `${player.riot_id_name}#${player.riot_id_tag_line}`;
      name.addEventListener("click", () => openPlayerModal(player.client_id));
      row.querySelector(".participant-status").textContent = recordStatusText(player);
      container.appendChild(row);
    });
  }
  document.getElementById("btn-update-all").disabled = activeUpdates > 0 || updatingAll;
  document.getElementById("btn-edit-participants").disabled = activeUpdates > 0 || updatingAll;
}

function updateModalRecordControls(player) {
  document.getElementById("btn-modal-refresh").disabled = activeUpdates > 0 || updatingAll;
  document.getElementById("modal-record-status").textContent = recordStatusText(player);
}

function renderRecordViews() {
  // Refresh the shared objects in-place: auction assignments and spending survive record updates.
  const selectedTeam = document.getElementById("bid-team-select").value;
  const modalId = currentModalPlayer?.client_id;
  const modalTab = currentModalTab;
  updateAppView();
  const select = document.getElementById("bid-team-select");
  if ([...select.options].some(option => option.value === selectedTeam && !option.disabled)) {
    select.value = selectedTeam;
    document.getElementById("bid-amount").max = state.teams[Number(selectedTeam)].budget;
  }
  if (modalId) { openPlayerModal(modalId); switchModalTab(modalTab); }
}

async function refreshPlayer(id, inBatch = false) {
  if (!hasSession || (!inBatch && (updatingAll || activeUpdates))) return false;
  const player = [...state.captains, ...state.allPlayers].find(item => item.client_id === id);
  if (!player || player.record_status === "loading") return false;
  activeUpdates++;
  player.record_status = "loading";
  player.record_error = "";
  renderRecordViews();
  let success = false;
  try {
    const result = await recordsClient.fetchPlayer(player);
    Object.assign(player, result.stats, { record_status: "ready" });
    state.version = result.version;
    success = true;
  } catch (error) {
    player.record_status = "error";
    player.record_error = error.message || "전적 조회에 실패했습니다.";
  } finally {
    activeUpdates--;
    renderRecordViews();
    if (!inBatch) document.getElementById("update-progress").textContent = success ? `${player.riot_id_name} 전적을 업데이트했습니다.${player.record_warning ? " 일부 통계는 재조회가 필요합니다." : ""}` : `${player.riot_id_name} 조회 실패. 각 유저의 상태를 확인하고 다시 시도해주세요.`;
  }
  return success;
}

async function updateAllPlayers() {
  if (updatingAll || activeUpdates || !hasSession) return;
  updatingAll = true;
  const players = [...state.captains, ...state.allPlayers];
  let next = 0, done = 0, succeeded = 0, partial = 0;
  const progress = document.getElementById("update-progress");
  progress.textContent = `전적 업데이트 중 · 0/${players.length}명`;
  renderRecordViews();
  async function worker() {
    while (next < players.length) {
      const player = players[next++];
      const ok = await refreshPlayer(player.client_id, true);
      if (ok) { succeeded++; if (player.record_warning) partial++; }
      done++;
      progress.textContent = `전적 업데이트 중 · ${done}/${players.length}명 (성공 ${succeeded}, 실패 ${done - succeeded})`;
    }
  }
  try { await Promise.all([worker(), worker()]); }
  finally {
    updatingAll = false;
    progress.textContent = `업데이트 완료 · 성공 ${succeeded}명 · 실패 ${done - succeeded}명${partial ? ` · 일부 통계 재조회 필요 ${partial}명` : ""}`;
    renderRecordViews();
  }
}
