/* 부산 하차 알리미 — 앱 로직 */
(function () {
  "use strict";

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const setupScreen = $("setup");
  const runScreen = $("running");
  const lineSelect = $("lineSelect");
  const fromSelect = $("fromSelect");
  const toSelect = $("toSelect");
  const routeInfo = $("routeInfo");
  const modeGroup = $("modeGroup");
  const alertBeforeSel = $("alertBefore");
  const startBtn = $("startBtn");

  const runLine = $("runLine");
  const bigNumber = $("bigNumber");
  const bigUnit = $("bigUnit");
  const etaBox = $("etaBox");
  const etaTime = $("etaTime");
  const progressBar = $("progressBar");
  const fromLabel = $("fromLabel");
  const toLabel = $("toLabel");
  const nextStation = $("nextStation");
  const passBtn = $("passBtn");
  const passBtnText = $("passBtnText");
  const stopBtn = $("stopBtn");
  const modeNote = $("modeNote");

  const alertOverlay = $("alertOverlay");
  const alertTitle = $("alertTitle");
  const alertSub = $("alertSub");
  const dismissBtn = $("dismissBtn");

  const STORE_KEY = "busan-metro-alarm";

  // ---------- 상태 ----------
  let mode = "time"; // time | gps | manual
  let state = null; // 진행 중 상태
  let ticker = null;
  let geoWatchId = null;
  let wakeLock = null;
  let audioCtx = null;
  let alertLoop = null;

  // =====================================================================
  // 설정 화면
  // =====================================================================
  function initSelectors() {
    Object.keys(LINES).forEach((key) => {
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = key;
      lineSelect.appendChild(opt);
    });

    const saved = loadSaved();
    if (saved && LINES[saved.line]) lineSelect.value = saved.line;

    fillStations();
    if (saved) {
      if (fromHas(saved.from)) fromSelect.value = saved.from;
      if (fromHas(saved.to)) toSelect.value = saved.to;
      if (saved.mode) selectMode(saved.mode);
      if (saved.alertBefore != null) alertBeforeSel.value = String(saved.alertBefore);
    }
    updateRouteInfo();
  }

  function fromHas(name) {
    return Array.from(fromSelect.options).some((o) => o.value === name);
  }

  function fillStations() {
    const stations = LINES[lineSelect.value].stations;
    fromSelect.innerHTML = "";
    toSelect.innerHTML = "";
    stations.forEach((s, i) => {
      const o1 = document.createElement("option");
      o1.value = s.name;
      o1.textContent = s.name;
      fromSelect.appendChild(o1);
      const o2 = document.createElement("option");
      o2.value = s.name;
      o2.textContent = s.name;
      toSelect.appendChild(o2);
    });
    // 기본값: 출발=첫역, 도착=마지막역
    fromSelect.selectedIndex = 0;
    toSelect.selectedIndex = stations.length - 1;
  }

  function currentPlan() {
    const line = lineSelect.value;
    const stations = LINES[line].stations;
    const fromIdx = stations.findIndex((s) => s.name === fromSelect.value);
    const toIdx = stations.findIndex((s) => s.name === toSelect.value);
    return { line, stations, fromIdx, toIdx, cfg: LINES[line] };
  }

  function updateRouteInfo() {
    const { stations, fromIdx, toIdx, cfg } = currentPlan();
    routeInfo.hidden = false;
    routeInfo.classList.remove("warn");

    if (fromIdx === toIdx) {
      routeInfo.innerHTML = "출발역과 도착역이 같아요. 다시 선택해 주세요.";
      routeInfo.classList.add("warn");
      startBtn.disabled = true;
      startBtn.style.opacity = 0.5;
      return;
    }
    startBtn.disabled = false;
    startBtn.style.opacity = 1;

    const stops = Math.abs(toIdx - fromIdx);
    const mins = Math.round((stops * cfg.avgHopSec) / 60);
    routeInfo.innerHTML =
      `<b>${stops}</b>개 역 이동 · 예상 <b>약 ${mins}분</b>`;

    if (mode === "gps") {
      const destCoord = stations[toIdx].coord;
      if (!destCoord) {
        routeInfo.innerHTML +=
          "<br>⚠️ 이 역은 GPS 좌표가 없어요. 시간/수동 모드를 추천해요.";
        routeInfo.classList.add("warn");
      }
    }
  }

  function selectMode(m) {
    mode = m;
    Array.from(modeGroup.querySelectorAll(".mode-btn")).forEach((b) => {
      b.classList.toggle("selected", b.dataset.mode === m);
    });
    updateRouteInfo();
  }

  // =====================================================================
  // 알림 시작
  // =====================================================================
  function start() {
    const { line, stations, fromIdx, toIdx, cfg } = currentPlan();
    if (fromIdx === toIdx || fromIdx < 0 || toIdx < 0) return;

    const dir = toIdx > fromIdx ? 1 : -1;

    state = {
      line, stations, fromIdx, toIdx, dir, cfg,
      currentIdx: fromIdx,
      hopStart: Date.now(),
      totalStops: Math.abs(toIdx - fromIdx),
      alertBefore: parseInt(alertBeforeSel.value, 10),
      approachAlerted: false,
      arrivalAlerted: false,
    };

    save();
    unlockAudio();
    requestWakeLock();

    // 화면 전환
    setupScreen.hidden = true;
    runScreen.hidden = false;
    runLine.textContent = line;
    runLine.style.background = cfg.color;
    fromLabel.textContent = stations[fromIdx].name;
    toLabel.textContent = stations[toIdx].name;

    // 모드별 표시
    if (mode === "time") {
      etaBox.hidden = false;
      passBtnText.textContent = "역 통과 (시간 보정용, 안 눌러도 됨)";
      modeNote.textContent =
        "예상 시간에 맞춰 자동으로 카운트다운돼요. 실제와 다르면 정차 시 '역 통과'를 눌러 보정하세요.";
    } else if (mode === "manual") {
      etaBox.hidden = true;
      passBtnText.textContent = "정차했어요 (탭)";
      modeNote.textContent = "역에 설 때마다 버튼을 누르면 남은 정거장이 줄어들어요.";
    } else {
      etaBox.hidden = false;
      etaTime.textContent = "측정 중…";
      passBtnText.textContent = "역 통과 (수동 보정)";
      modeNote.textContent = "GPS로 위치를 추적해 목적지에 가까워지면 알려드려요. 지하 구간에선 신호가 약할 수 있어요.";
      startGeo();
    }

    render();
    ticker = setInterval(tick, 1000);
  }

  // =====================================================================
  // 진행 로직
  // =====================================================================
  function remainingStops() {
    return Math.abs(state.toIdx - state.currentIdx);
  }

  function advance() {
    // currentIdx 를 도착역 방향으로 한 칸 이동
    if (state.currentIdx !== state.toIdx) {
      state.currentIdx += state.dir;
      state.hopStart = Date.now();
    }
  }

  function tick() {
    if (!state) return;

    if (mode === "time") {
      const elapsed = (Date.now() - state.hopStart) / 1000;
      if (state.currentIdx !== state.toIdx && elapsed >= state.cfg.avgHopSec) {
        advance();
      }
    }
    // gps 는 위치 콜백에서 currentIdx 갱신, manual 은 탭에서 갱신
    render();
    checkAlert();
  }

  function render() {
    if (!state) return;
    const rem = remainingStops();
    bigNumber.textContent = rem === 0 ? "도착" : rem;
    bigUnit.textContent = rem === 0 ? "" : "정거장 남음";
    if (rem === 0) bigNumber.style.fontSize = "64px";

    // 진행바
    const pct = state.totalStops === 0 ? 100 :
      ((state.totalStops - rem) / state.totalStops) * 100;
    progressBar.style.width = Math.max(0, Math.min(100, pct)) + "%";

    // 다음 역
    if (rem === 0) {
      nextStation.textContent = "도착!";
    } else {
      const nextIdx = state.currentIdx + state.dir;
      const nx = state.stations[nextIdx];
      nextStation.textContent = "다음 역 " + (nx ? nx.name : "");
    }

    // ETA (시간 모드)
    if (mode === "time") {
      const elapsed = (Date.now() - state.hopStart) / 1000;
      const sec = Math.max(0, rem * state.cfg.avgHopSec - elapsed);
      etaTime.textContent = fmtTime(sec);
    }
  }

  function checkAlert() {
    if (!state) return;
    const rem = remainingStops();

    if (!state.approachAlerted && rem <= state.alertBefore && rem > 0) {
      state.approachAlerted = true;
      fireAlert(`${rem}정거장 전!`, "내릴 준비 하세요");
    }
    if (!state.arrivalAlerted && rem === 0) {
      state.arrivalAlerted = true;
      fireAlert("도착!", `${state.stations[state.toIdx].name}역이에요. 내리세요!`);
    }
  }

  // =====================================================================
  // GPS
  // =====================================================================
  function startGeo() {
    if (!("geolocation" in navigator)) {
      etaTime.textContent = "GPS 미지원";
      return;
    }
    geoWatchId = navigator.geolocation.watchPosition(
      onPosition,
      (err) => { etaTime.textContent = "위치 권한 필요"; },
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 }
    );
  }

  function onPosition(pos) {
    if (!state) return;
    const { latitude: lat, longitude: lng } = pos.coords;

    // 좌표가 있는 역들 중 가장 가까운 역 찾기
    let nearestIdx = state.currentIdx;
    let nearestDist = Infinity;
    state.stations.forEach((s, i) => {
      if (!s.coord) return;
      const d = haversine(lat, lng, s.coord[0], s.coord[1]);
      if (d < nearestDist) { nearestDist = d; nearestIdx = i; }
    });

    // 진행 방향으로만 전진 (뒤로 튀는 것 방지)
    if (state.dir === 1 && nearestIdx > state.currentIdx) state.currentIdx = nearestIdx;
    if (state.dir === -1 && nearestIdx < state.currentIdx) state.currentIdx = nearestIdx;

    // 목적지까지 거리 표시
    const dest = state.stations[state.toIdx].coord;
    if (dest) {
      const dm = haversine(lat, lng, dest[0], dest[1]);
      etaTime.textContent = dm >= 1000
        ? (dm / 1000).toFixed(1) + " km"
        : Math.round(dm) + " m";
    }
    render();
    checkAlert();
  }

  // =====================================================================
  // 알람 (소리 + 진동 + 오버레이)
  // =====================================================================
  function fireAlert(title, sub) {
    alertTitle.textContent = title;
    alertSub.textContent = sub;
    alertOverlay.hidden = false;
    startBeep();
    startVibrate();
  }

  function dismissAlert() {
    alertOverlay.hidden = true;
    stopBeep();
    stopVibrate();
  }

  function unlockAudio() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC && !audioCtx) audioCtx = new AC();
      if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
    } catch (e) { /* noop */ }
  }

  function beepOnce() {
    if (!audioCtx) return;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "square";
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.4, audioCtx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.35);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.36);
  }

  function startBeep() {
    unlockAudio();
    stopBeep();
    beepOnce();
    alertLoop = setInterval(beepOnce, 700);
  }
  function stopBeep() {
    if (alertLoop) { clearInterval(alertLoop); alertLoop = null; }
  }

  let vibrateLoop = null;
  function startVibrate() {
    if (!("vibrate" in navigator)) return;
    stopVibrate();
    const pattern = [400, 200, 400, 200, 400];
    navigator.vibrate(pattern);
    vibrateLoop = setInterval(() => navigator.vibrate(pattern), 1600);
  }
  function stopVibrate() {
    if (vibrateLoop) { clearInterval(vibrateLoop); vibrateLoop = null; }
    if ("vibrate" in navigator) navigator.vibrate(0);
  }

  // =====================================================================
  // Wake Lock (화면 꺼짐 방지)
  // =====================================================================
  async function requestWakeLock() {
    try {
      if ("wakeLock" in navigator) {
        wakeLock = await navigator.wakeLock.request("screen");
      }
    } catch (e) { /* 무시 */ }
  }
  function releaseWakeLock() {
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state) requestWakeLock();
  });

  // =====================================================================
  // 종료
  // =====================================================================
  function stop() {
    if (ticker) { clearInterval(ticker); ticker = null; }
    if (geoWatchId != null) { navigator.geolocation.clearWatch(geoWatchId); geoWatchId = null; }
    dismissAlert();
    releaseWakeLock();
    state = null;
    bigNumber.style.fontSize = "";
    runScreen.hidden = true;
    setupScreen.hidden = false;
  }

  // =====================================================================
  // 유틸
  // =====================================================================
  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function fmtTime(sec) {
    sec = Math.round(sec);
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        line: lineSelect.value,
        from: fromSelect.value,
        to: toSelect.value,
        mode,
        alertBefore: alertBeforeSel.value,
      }));
    } catch (e) { /* noop */ }
  }
  function loadSaved() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)); }
    catch (e) { return null; }
  }

  // =====================================================================
  // 이벤트 바인딩
  // =====================================================================
  lineSelect.addEventListener("change", () => { fillStations(); updateRouteInfo(); });
  fromSelect.addEventListener("change", updateRouteInfo);
  toSelect.addEventListener("change", updateRouteInfo);
  alertBeforeSel.addEventListener("change", save);
  modeGroup.addEventListener("click", (e) => {
    const btn = e.target.closest(".mode-btn");
    if (btn) selectMode(btn.dataset.mode);
  });
  startBtn.addEventListener("click", start);
  stopBtn.addEventListener("click", stop);
  dismissBtn.addEventListener("click", dismissAlert);
  passBtn.addEventListener("click", () => {
    if (!state) return;
    advance();
    render();
    checkAlert();
  });

  // 서비스워커 등록 (PWA)
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    });
  }

  initSelectors();
})();
