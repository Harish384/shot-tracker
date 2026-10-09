/*
  app.js (version 3) - Marksman Training: connects the camera, the screens
  and the detectors.

  Steps (the variable "step" says where we are):
    "home"     -> start page: last session, Start session, Past reports
    "rim"      -> drag a box around the rim
    "ball"     -> optional: tap the ball for a colour check
    "ready"    -> test that the ball is seen, then Start tracking
    "tracking" -> counting shots (you pick your spot first)
    "lost"     -> the phone stopped the camera
    "report"   -> session report with the shot chart
    "reports"  -> list of past reports

  Every frame while tracking:
    camera -> BallDetector (where is the ball?) -> ShotDetector (make/miss?)
           -> Session (score, per spot) -> draw on screen
*/

// ---------- 1. Elements ----------
const $ = (id) => document.getElementById(id);
const video = $("camera");
const overlay = $("overlay");
const ctx = overlay.getContext("2d");

// ---------- 2. App state ----------
let step = "home";
let hoop = null;                  // { x, y, w, h } normalised rim box
let hoopAspect = 0;               // picture width/height when the rim was marked
let dragStart = null;
let dragNow = null;
const detector = new BallDetector();
let shots = null;                 // ShotDetector
let session = null;               // Session
let lastBall = null;
const trail = [];
let lastProcessed = 0;
let bannerTimer = null;
let audio = null;
let wakeLock = null;
let seenA = null;                 // older ball sighting { x, y, t }, for prediction
let seenB = null;                 // newest ball sighting
let lastSeenAt = -Infinity;

let track = null;                 // the camera's video track
let caps = {};                    // what this camera lets us change
let startingCamera = false;
let settingsOpen = false;
let panelWasOpen = false;
let stepBeforeLost = null;

let currentSpot = null;           // spot id you're shooting from, e.g. "lw"
let pickerOpen = false;
let pickerPurpose = null;         // "start" (before tracking) or "change" (during)

const CAMERA_STEPS = ["rim", "ball", "ready", "tracking"];
const PAGES = ["home", "reports", "report"];
const HISTORY_KEY = "shot-tracker-history";   // same key as before, so old sessions stay

// ---------- 3. Helpers ----------

// Where the camera picture sits on screen ("contain" may add black bars).
function videoRect() {
  const sw = overlay.clientWidth, sh = overlay.clientHeight;
  const vw = video.videoWidth || 16, vh = video.videoHeight || 9;
  const scale = Math.min(sw / vw, sh / vh);
  const w = vw * scale, h = vh * scale;
  return { x: (sw - w) / 2, y: (sh - h) / 2, w, h };
}

// Screen pixels -> normalised picture position (0-1).
function toNorm(px, py) {
  const r = videoRect();
  return {
    x: Math.min(1, Math.max(0, (px - r.x) / r.w)),
    y: Math.min(1, Math.max(0, (py - r.y) / r.h)),
  };
}

// Normalised picture position -> screen pixels.
function toScreen(nx, ny) {
  const r = videoRect();
  return { x: r.x + nx * r.w, y: r.y + ny * r.h };
}

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  overlay.width = overlay.clientWidth * dpr;
  overlay.height = overlay.clientHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", resizeCanvas);

// Show one full-screen page (or none, to see the camera).
function showPage(id) {
  for (const p of PAGES) $(p).hidden = p !== id;
  if (id) $(id).scrollTop = 0;
}

// Hide everything that sits on top of the camera.
function hideCameraUI() {
  for (const id of ["scoreboard", "controls", "ballStatus", "banner", "panel", "settingsBtn"]) {
    $(id).hidden = true;
  }
}

function showPanel({ label, title, text, primary, secondary, exit }) {
  // While settings are open the panel stays hidden; it returns when they close.
  if (settingsOpen) panelWasOpen = true;
  else $("panel").hidden = false;
  $("panel").classList.remove("top");
  $("stepLabel").textContent = label;
  $("panelTitle").textContent = title;
  $("panelText").textContent = text;
  $("primaryBtn").hidden = !primary;
  if (primary) $("primaryBtn").textContent = primary;
  $("secondaryBtn").hidden = !secondary;
  if (secondary) $("secondaryBtn").textContent = secondary;
  $("exitBtn").hidden = !exit;
  if (exit) $("exitBtn").textContent = exit;
  $("errorText").hidden = true;
}

function showError(message) {
  $("errorText").textContent = message;
  $("errorText").hidden = false;
}

function beep(freq) {
  if (!audio) return;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.2, audio.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.25);
  osc.connect(gain).connect(audio.destination);
  osc.start();
  osc.stop(audio.currentTime + 0.25);
}

async function keepScreenOn() {
  try {
    if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
  } catch (e) { /* not allowed: the app still works */ }
}

function releaseScreen() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}

// Saved sessions live in this phone's browser storage.
function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; } catch (e) { return []; }
}
function saveHistory(list) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list)); } catch (e) { /* ignore */ }
}

// Dates and times in the phone's own format, e.g. "Friday, 9 October 2026" and "22:40".
const longDate = (d) => d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const shortDate = (d) => d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
const clock = (d) => d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const pctOf = (made, att) => (att ? (made / att) * 100 : 0);

// ---------- 4. Camera settings (zoom, brightness, lock, sensitivity) ----------

function setupCameraControls() {
  caps = track && track.getCapabilities ? track.getCapabilities() : {};
  const settings = track && track.getSettings ? track.getSettings() : {};
  let any = false;

  if (caps.zoom) {
    any = true;
    const z = $("zoomInput");
    z.min = caps.zoom.min; z.max = caps.zoom.max; z.step = caps.zoom.step || 0.1;
    z.value = settings.zoom || caps.zoom.min;
    $("zoomOut").textContent = Number(z.value).toFixed(1) + "x";
    $("zoomRow").hidden = false;
  }
  if (caps.exposureCompensation) {
    any = true;
    const b = $("brightInput");
    b.min = caps.exposureCompensation.min; b.max = caps.exposureCompensation.max;
    b.step = caps.exposureCompensation.step || 0.1;
    b.value = settings.exposureCompensation || 0;
    $("brightOut").textContent = Number(b.value).toFixed(1);
    $("brightRow").hidden = false;
  }
  if (caps.exposureMode && caps.exposureMode.includes("manual")) {
    any = true;
    $("lockRow").hidden = false;
  } else {
    $("lockInput").checked = false;
  }
  $("noCameraControls").hidden = any;
}

async function applyCamera(setting) {
  if (!track) return;
  try { await track.applyConstraints({ advanced: [setting] }); } catch (e) { /* refused */ }
  detector.resetBackground();
}

async function setExposureLock(on) {
  if (!track || !caps.exposureMode) return;
  const setting = {};
  const mode = on ? "manual" : "continuous";
  if (caps.exposureMode.includes(mode)) setting.exposureMode = mode;
  if (caps.whiteBalanceMode && caps.whiteBalanceMode.includes(mode)) setting.whiteBalanceMode = mode;
  const current = track.getSettings();
  if (on && caps.exposureTime && current.exposureTime) setting.exposureTime = current.exposureTime;
  await applyCamera(setting);
}

function applySensitivity() {
  const level = Number($("sensInput").value);
  detector.sensitivity = 37 - level * 3;
  $("sensOut").textContent = level;
}

$("zoomInput").addEventListener("input", (e) => {
  $("zoomOut").textContent = Number(e.target.value).toFixed(1) + "x";
  applyCamera({ zoom: Number(e.target.value) });
});
$("brightInput").addEventListener("input", (e) => {
  $("brightOut").textContent = Number(e.target.value).toFixed(1);
  applyCamera({ exposureCompensation: Number(e.target.value) });
});
$("lockInput").addEventListener("change", (e) => {
  if (step === "tracking") setExposureLock(e.target.checked);
});
$("sensInput").addEventListener("input", applySensitivity);
$("ignoreBgInput").addEventListener("change", (e) => {
  detector.ignoreBallColourBackground = e.target.checked;
});

function openSettings() {
  if (settingsOpen || pickerOpen) return;
  settingsOpen = true;
  const zoomAllowed = step === "rim";
  $("zoomInput").disabled = !zoomAllowed;
  $("zoomNote").textContent = zoomAllowed
    ? "Zoom in so the hoop looks bigger, then mark the rim."
    : "Zoom is locked after you mark the rim. Use Redo setup to change it.";
  panelWasOpen = !$("panel").hidden;
  $("panel").hidden = true;
  $("settingsBtn").hidden = true;
  $("settings").hidden = false;
}

function closeSettings() {
  if (!settingsOpen) return;
  settingsOpen = false;
  $("settings").hidden = true;
  $("settingsBtn").hidden = false;
  if (panelWasOpen) $("panel").hidden = false;
}

$("settingsBtn").addEventListener("click", openSettings);
$("closeSettingsBtn").addEventListener("click", closeSettings);

// ---------- 5. Camera on / off ----------

/*
  Turn the camera on. Returns "" if it worked, or an error message.
*/
async function openCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return "This browser can't use the camera here. Open the app from its https:// link.";
  }
  stopCamera();                            // never run two cameras at once
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 60 },
      },
      audio: false,
    });
    video.srcObject = stream;
    track = stream.getVideoTracks()[0];
    track.addEventListener("ended", cameraLost);   // the phone switched the camera off
    await video.play();
  } catch (err) {
    if (err.name === "NotAllowedError") {
      return "Camera permission was blocked. Allow camera access for this site in your browser settings, then reload.";
    }
    return "Couldn't start the camera: " + err.message;
  }
  setupCameraControls();
  applySensitivity();
  resizeCanvas();
  return "";
}

function stopCamera() {
  if (video.srcObject) {
    video.srcObject.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  }
  track = null;
}

// "Start session" on the home page.
async function startSession() {
  if (startingCamera) return;                  // ignore double taps
  startingCamera = true;
  $("startSessionBtn").disabled = true;
  $("homeError").hidden = true;
  const err = await openCamera();
  startingCamera = false;
  $("startSessionBtn").disabled = false;
  if (err) {
    $("homeError").textContent = err;
    $("homeError").hidden = false;
    return;
  }
  if (!audio) {
    try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { audio = null; }
  }
  session = null;
  currentSpot = null;
  showPage(null);                              // hide the home page, show the camera
  $("settingsBtn").hidden = false;
  goToRim();
}

// The phone stopped the camera (other app, screen locked...).
function cameraLost() {
  if (!CAMERA_STEPS.includes(step)) return;
  stepBeforeLost = step;
  step = "lost";
  closeSettings();
  closePicker();
  $("controls").hidden = true;
  $("settingsBtn").hidden = true;
  $("ballStatus").hidden = true;
  const hasShots = session && session.attempted > 0;
  showPanel({
    label: "Paused",
    title: "Camera stopped",
    text: "Your phone switched the camera off (another app, or the screen locked). Your score so far is kept. Keep the phone in the same place and restart.",
    primary: "Restart camera",
    exit: hasShots ? "End session" : "Home",
  });
}

async function restartCamera() {
  if (startingCamera) return;
  startingCamera = true;
  $("primaryBtn").disabled = true;
  const err = await openCamera();
  startingCamera = false;
  $("primaryBtn").disabled = false;
  if (err) { showError(err); return; }
  $("settingsBtn").hidden = false;
  const turned = hoop && Math.abs(video.videoWidth / video.videoHeight - hoopAspect) > 0.05;
  if (stepBeforeLost === "tracking" && hoop && !turned) {
    beginTracking();                     // carry on with the same score and spot
  } else if (stepBeforeLost === "ready" && hoop && !turned) {
    goToReady();
  } else {
    goToRim();
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !CAMERA_STEPS.includes(step)) return;
  if (step === "tracking") keepScreenOn();
  if (!track || track.readyState === "ended") cameraLost();
  else if (video.paused) video.play().catch(() => cameraLost());
});

// The picture changed shape: the phone was rotated after the rim was marked.
video.addEventListener("resize", () => {
  if (!hoop || !video.videoWidth || !CAMERA_STEPS.includes(step)) return;
  if (Math.abs(video.videoWidth / video.videoHeight - hoopAspect) > 0.05) {
    closeSettings();
    closePicker();
    $("controls").hidden = true;
    $("scoreboard").hidden = true;
    goToRim();
    showError("The picture turned (phone rotated). Mark the rim again. Your score so far is kept.");
  }
});

// ---------- 6. Setup steps ----------

function goToRim() {
  step = "rim";
  hoop = null;
  $("swatchRow").hidden = true;
  $("ballStatus").hidden = true;
  showPanel({
    label: "Setup · 1 of 2",
    title: "Mark the rim",
    text: "Far from the hoop? Tap Camera and zoom in first. Then drag a tight, thin box around the metal rim (not the net). Keep the phone still from now on.",
    secondary: "Move this panel up",
    exit: "Home",
  });
}

function goToBall() {
  step = "ball";
  showPanel({
    label: "Setup · 2 of 2",
    title: "Ball colour (optional)",
    text: "The app finds the ball by its size, shape and movement. If other things often move near the hoop, tap the ball so it also checks the colour.",
    secondary: "Skip",
    exit: "Home",
  });
  $("swatchRow").hidden = true;
}

function goToReady() {
  if (!hoop) { goToRim(); return; }
  step = "ready";
  if (video.videoWidth) detector.setHoop(hoop, video.videoWidth, video.videoHeight);
  trail.length = 0;
  showPanel({
    label: "Ready",
    title: "Test, then start",
    text: "Throw the ball up near the hoop. A green circle and \"Ball seen\" mean the app can see it. Nothing is counted until you start tracking.",
    primary: "Start tracking",
    secondary: "Redo setup",
    exit: "Home",
  });
}

// ---------- 7. Spot picker (shot chart) ----------

function openPicker(purpose) {
  if (pickerOpen) return;
  closeSettings();
  pickerOpen = true;
  pickerPurpose = purpose;
  Court.renderPicker($("pickCourt"), currentSpot);
  $("pickCancelBtn").textContent = purpose === "start" ? "Back" : "Cancel";
  $("pickHint").textContent = purpose === "start"
    ? "Tap the spot you'll shoot from. Change it between sets with the Spot button."
    : "Counting is paused while this is open. Tap your new spot.";
  if (purpose === "start") $("panel").hidden = true;
  $("spotPicker").hidden = false;
}

function closePicker() {
  if (!pickerOpen) return;
  pickerOpen = false;
  $("spotPicker").hidden = true;
}

function chooseSpot(id) {
  if (!pickerOpen) return;
  const purpose = pickerPurpose;
  currentSpot = id;
  closePicker();
  if (purpose === "start") {
    beginTracking();
  } else {
    // Fresh shot detector: forget any half-finished shot from while you walked.
    shots = new ShotDetector(hoop);
    seenA = seenB = null;
    updateScoreboard();
  }
}

function cancelPicker() {
  const purpose = pickerPurpose;
  closePicker();
  if (purpose === "start") $("panel").hidden = false;   // back to the Ready panel
}

// Tapping a spot circle: find the <g data-spot="..."> that was tapped.
$("pickCourt").addEventListener("click", (e) => {
  const g = e.target.closest("[data-spot]");
  if (g) chooseSpot(g.dataset.spot);
});
$("pickCourt").addEventListener("keydown", (e) => {
  const g = e.target.closest("[data-spot]");
  if (g && (e.key === "Enter" || e.key === " ")) {
    e.preventDefault();
    chooseSpot(g.dataset.spot);
  }
});
$("pickMixedBtn").addEventListener("click", () => chooseSpot("mixed"));
$("pickCancelBtn").addEventListener("click", cancelPicker);

function spotName(id) {
  const s = Court.byId(id);
  return s ? s.name : "Mixed spots";
}

// ---------- 8. Tracking and scoring ----------

function beginTracking() {
  if (!video.videoWidth) { cameraLost(); return; }
  step = "tracking";
  if (!session) session = new Session();     // keep the score after a restart or rotation
  shots = new ShotDetector(hoop);
  detector.setHoop(hoop, video.videoWidth, video.videoHeight);
  trail.length = 0;
  seenA = seenB = null;
  closeSettings();
  $("panel").hidden = true;
  $("scoreboard").hidden = false;
  $("controls").hidden = false;
  $("settingsBtn").hidden = false;
  updateScoreboard();
  keepScreenOn();
  if ($("lockInput").checked) setExposureLock(true);
}

function updateScoreboard() {
  if (!session) return;
  $("fgValue").textContent = session.percentage.toFixed(1);
  $("madeValue").textContent = session.made;
  $("missValue").textContent = session.attempted - session.made;
  $("shotsValue").textContent = session.attempted;
  const st = session.spotStats()[currentSpot] || { made: 0, att: 0 };
  $("spotName").textContent = spotName(currentSpot);
  $("spotScore").textContent = `${st.made}/${st.att}`;
}

function showBanner(result) {
  const banner = $("banner");
  banner.textContent = result === "make" ? "MAKE" : "MISS";
  banner.className = "banner " + result;
  banner.hidden = false;
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => { banner.hidden = true; }, 1000);
}

function onShot(result) {
  session.record(result === "make", currentSpot);
  updateScoreboard();
  showBanner(result);
  beep(result === "make" ? 880 : 220);
  if (navigator.vibrate) navigator.vibrate(result === "make" ? 80 : [40, 60, 40]);
}

function endSession() {
  closeSettings();
  closePicker();
  if (!session) session = new Session();
  session.end();
  const rec = session.toRecord();
  if (session.attempted > 0) {
    const list = loadHistory();
    list.unshift(rec);                       // newest first
    saveHistory(list.slice(0, 50));          // keep the 50 most recent
  }
  step = "report";
  hideCameraUI();
  releaseScreen();
  setExposureLock(false);
  renderReport(rec, "ended");
  showPage("report");
}

// ---------- 9. Report, past reports, home ----------

/*
  Fill the report page from a saved record.
  mode "ended" = just finished (New session / Home buttons),
  mode "past"  = opened from Past reports (Back button).
*/
function renderReport(rec, mode) {
  const start = new Date(rec.date);
  const end = rec.end ? new Date(rec.end) : null;
  $("repDate").textContent = longDate(start);
  let time = clock(start);
  if (end) {
    const mins = Math.max(1, Math.round((end - start) / 60000));
    time += ` – ${clock(end)} · ${mins} min`;
  }
  $("repTime").textContent = time;

  $("repFg").textContent = pctOf(rec.made, rec.attempted).toFixed(1);
  $("repMade").textContent = rec.made;
  $("repMiss").textContent = rec.attempted - rec.made;
  $("repShots").textContent = rec.attempted;

  const spots = rec.spots || {};
  Court.renderReport($("repCourt"), spots);

  // Table rows: every spot you shot from, in court order, then "Mixed spots".
  const rows = Court.spots
    .filter((s) => spots[s.id])
    .map((s) => ({ name: s.name, ...spots[s.id] }));   // "..." copies made and att in
  if (spots.mixed) rows.push({ name: "Mixed spots", ...spots.mixed });

  const body = $("repTableBody");
  body.textContent = "";
  if (rows.length === 0) {
    const cell = body.insertRow().insertCell();
    cell.colSpan = 4;
    cell.textContent = "No spot data for this session.";
  }
  for (const r of rows) {
    const row = body.insertRow();
    for (const v of [r.name, r.made, r.att, pctOf(r.made, r.att).toFixed(1)]) {
      row.insertCell().textContent = v;
    }
  }
  if (rows.length > 1) {
    const row = body.insertRow();
    row.className = "total";
    for (const v of ["Total", rec.made, rec.attempted, pctOf(rec.made, rec.attempted).toFixed(1)]) {
      row.insertCell().textContent = v;
    }
  }

  // Best spot: highest % among spots with at least 3 shots (or any spot if none have 3).
  const named = rows.filter((r) => r.name !== "Mixed spots");
  const pool = named.filter((r) => r.att >= 3).length ? named.filter((r) => r.att >= 3) : named;
  const best = pool.reduce((a, b) => (!a || pctOf(b.made, b.att) > pctOf(a.made, a.att) ? b : a), null);
  $("repBest").textContent = best ? `${best.name} (${pctOf(best.made, best.att).toFixed(0)}%)` : "–";

  $("repEnded").hidden = mode !== "ended";
  $("repPast").hidden = mode !== "past";
}

function renderHome() {
  const list = loadHistory();
  $("lastEmpty").hidden = list.length > 0;
  $("lastFilled").hidden = list.length === 0;
  if (list.length === 0) return;
  const last = list[0];
  $("lastDate").textContent = `${shortDate(new Date(last.date))} · ${clock(new Date(last.date))}`;
  $("lastFg").textContent = pctOf(last.made, last.attempted).toFixed(1);
  $("lastMade").textContent = `${last.made} of ${last.attempted} made`;
  let made = 0, att = 0;
  for (const s of list) { made += s.made; att += s.attempted; }
  $("allTime").textContent = `All sessions: ${made}/${att} · ${pctOf(made, att).toFixed(1)}% over ${list.length} session${list.length === 1 ? "" : "s"}`;
}

function goHome() {
  closeSettings();
  closePicker();
  stopCamera();
  releaseScreen();
  hideCameraUI();
  step = "home";
  session = null;
  hoop = null;
  renderHome();
  showPage("home");
}

function openReports() {
  step = "reports";
  const list = loadHistory();
  const ul = $("reportsList");
  ul.textContent = "";
  $("reportsEmpty").hidden = list.length > 0;
  list.forEach((rec, i) => {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.className = "btn report-row";
    btn.type = "button";
    const d = new Date(rec.date);
    const spotCount = Object.keys(rec.spots || {}).length;
    // Build the row with textContent (safe, never runs as code).
    const date = document.createElement("span"); date.className = "r-date"; date.textContent = longDate(d);
    const pct = document.createElement("span"); pct.className = "r-pct"; pct.textContent = pctOf(rec.made, rec.attempted).toFixed(1) + "%";
    const sub = document.createElement("span"); sub.className = "r-sub";
    sub.textContent = `${clock(d)} · ${rec.made}/${rec.attempted} made` + (spotCount ? ` · ${spotCount} spot${spotCount === 1 ? "" : "s"}` : "");
    btn.append(date, pct, sub);
    btn.addEventListener("click", () => {
      step = "report";
      renderReport(list[i], "past");
      showPage("report");
    });
    li.append(btn);
    ul.append(li);
  });
  showPage("reports");
}

// ---------- 10. Processing camera frames ----------

function predict(now) {
  if (!seenA || !seenB || now - seenB.t > 300) return null;
  const dt = seenB.t - seenA.t;
  if (dt <= 0) return null;
  const k = (now - seenB.t) / dt;
  return { x: seenB.x + (seenB.x - seenA.x) * k, y: seenB.y + (seenB.y - seenA.y) * k };
}

function updateBallStatus(ball, now) {
  if (ball) lastSeenAt = now;
  const seen = now - lastSeenAt < 400;
  const el = $("ballStatus");
  el.hidden = false;
  el.textContent = seen ? "Ball seen" : "Looking for the ball";
  el.classList.toggle("seen", seen);
}

function processFrame(now) {
  if (step !== "tracking" && step !== "ready") return;
  const ball = detector.detect(video, predict(now));
  lastBall = ball;
  if (ball) {
    seenA = seenB;
    seenB = { x: ball.x, y: ball.y, t: now };
    trail.push(ball);
    if (trail.length > 20) trail.shift();
  }
  updateBallStatus(ball, now);
  // Count only while tracking, and not while you're choosing a new spot.
  if (step !== "tracking" || pickerOpen) return;
  const result = shots.update(now, ball ? { x: ball.x, y: ball.y } : null);
  if (result) onShot(result);
}

const hasFrameCallback = "requestVideoFrameCallback" in HTMLVideoElement.prototype;
function onVideoFrame(now) {
  processFrame(now);
  video.requestVideoFrameCallback(onVideoFrame);
}
if (hasFrameCallback) video.requestVideoFrameCallback(onVideoFrame);

function tick(now) {
  if (!hasFrameCallback && now - lastProcessed >= 16) {
    lastProcessed = now;
    processFrame(now);
  }
  draw();
  requestAnimationFrame(tick);
}

// ---------- 11. Drawing on the camera ----------

function draw() {
  ctx.clearRect(0, 0, overlay.clientWidth, overlay.clientHeight);
  if (!CAMERA_STEPS.includes(step)) return;

  if (step === "rim" && dragStart && dragNow) {
    ctx.strokeStyle = "#ffb020";
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(dragStart.x, dragStart.y, dragNow.x - dragStart.x, dragNow.y - dragStart.y);
    ctx.setLineDash([]);
  }

  if (hoop) {
    const a = toScreen(hoop.x, hoop.y);
    const b = toScreen(hoop.x + hoop.w, hoop.y + hoop.h);
    ctx.strokeStyle = "#ffb020";
    ctx.lineWidth = 2;
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    const mid = (a.y + b.y) / 2;
    ctx.beginPath();
    ctx.moveTo(a.x, mid);
    ctx.lineTo(b.x, mid);
    ctx.stroke();
  }

  if (step !== "tracking" && step !== "ready") return;

  if ((step === "ready" || $("debugInput").checked) && detector.zone) {
    const z = detector.zone;
    const a = toScreen(z.x, z.y);
    const b = toScreen(z.x + z.w, z.y + z.h);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.6)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.setLineDash([]);
    ctx.strokeStyle = "#ff5a52";
    for (const c of detector.candidates) {
      const [bx, by, bw, bh] = c.box;
      const p = toScreen(z.x + (bx / detector.workW) * z.w, z.y + (by / detector.workH) * z.h);
      const q = toScreen(z.x + ((bx + bw) / detector.workW) * z.w, z.y + ((by + bh) / detector.workH) * z.h);
      ctx.strokeRect(p.x, p.y, q.x - p.x, q.y - p.y);
    }
  }

  ctx.fillStyle = "rgba(255, 255, 255, 0.75)";
  for (const p of trail) {
    const s = toScreen(p.x, p.y);
    ctx.beginPath();
    ctx.arc(s.x, s.y, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  if (lastBall) {
    const s = toScreen(lastBall.x, lastBall.y);
    const r = Math.max(8, lastBall.r * videoRect().w);
    ctx.strokeStyle = "#2fd27a";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.stroke();
  }
}

// ---------- 12. Touch input on the camera ----------

overlay.addEventListener("pointerdown", (e) => {
  if (settingsOpen || pickerOpen) return;
  if (step === "rim") {
    dragStart = { x: e.offsetX, y: e.offsetY };
    dragNow = dragStart;
    overlay.setPointerCapture(e.pointerId);
  } else if (step === "ball") {
    const p = toNorm(e.offsetX, e.offsetY);
    const colour = detector.sampleColour(video, p.x, p.y);
    if (colour) {
      $("swatch").style.background = colour;
      $("swatchText").textContent = "Colour check on.";
      goToReady();
      $("swatchRow").hidden = false;
    } else {
      showError("That spot looks grey or white. Tap right on the ball.");
    }
  }
});

overlay.addEventListener("pointermove", (e) => {
  if (step === "rim" && dragStart) dragNow = { x: e.offsetX, y: e.offsetY };
});

overlay.addEventListener("pointerup", () => {
  if (step !== "rim" || !dragStart) return;
  const a = toNorm(Math.min(dragStart.x, dragNow.x), Math.min(dragStart.y, dragNow.y));
  const b = toNorm(Math.max(dragStart.x, dragNow.x), Math.max(dragStart.y, dragNow.y));
  dragStart = dragNow = null;
  if (b.x - a.x < 0.01 || b.y - a.y < 0.003) {
    showError("That box is too small. Drag across the whole rim, or zoom in first.");
    return;
  }
  hoop = { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
  hoopAspect = video.videoWidth / video.videoHeight;
  goToBall();
});

function cancelDrag() { dragStart = dragNow = null; }
overlay.addEventListener("pointercancel", cancelDrag);
overlay.addEventListener("lostpointercapture", () => { if (dragStart) cancelDrag(); });

// ---------- 13. Buttons ----------

$("primaryBtn").addEventListener("click", () => {
  if (step === "ready") openPicker("start");
  else if (step === "lost") restartCamera();
});

$("secondaryBtn").addEventListener("click", () => {
  if (step === "rim") {
    const top = $("panel").classList.toggle("top");
    $("secondaryBtn").textContent = top ? "Move this panel down" : "Move this panel up";
  } else if (step === "ball") {
    detector.mode = "shape";
    goToReady();
  } else if (step === "ready") {
    goToRim();
  }
});

$("exitBtn").addEventListener("click", () => {
  if (step === "lost" && session && session.attempted > 0) endSession();
  else goHome();
});

$("spotBtn").addEventListener("click", () => openPicker("change"));
$("undoBtn").addEventListener("click", () => { session.undo(); updateScoreboard(); });
$("flipBtn").addEventListener("click", () => { session.flipLast(); updateScoreboard(); });
$("addMakeBtn").addEventListener("click", () => onShot("make"));
$("addMissBtn").addEventListener("click", () => onShot("miss"));
$("endBtn").addEventListener("click", endSession);

$("startSessionBtn").addEventListener("click", startSession);
$("pastReportsBtn").addEventListener("click", openReports);
$("reportsBackBtn").addEventListener("click", () => { step = "home"; renderHome(); showPage("home"); });
$("repBackBtn").addEventListener("click", openReports);
$("repHomeBtn").addEventListener("click", goHome);
$("repNewBtn").addEventListener("click", () => {
  session = null;                          // a brand-new score
  showPage(null);
  $("settingsBtn").hidden = false;
  goToReady();                             // same phone position: keep the rim box
  if (!track || track.readyState === "ended") cameraLost();
});

// ---------- 14. Go! ----------
renderHome();
showPage("home");
resizeCanvas();
requestAnimationFrame(tick);
