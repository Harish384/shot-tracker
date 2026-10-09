/*
  app.js (version 2) - the main app. Connects the camera, the screens and the detectors.

  Steps:
    "start"    -> press Start camera
    "rim"      -> (optional: zoom in with Camera settings) drag a box around the rim
    "ball"     -> tap the ball to also use its colour, or skip to track by shape + movement
    "ready"    -> press Start tracking
    "tracking" -> counting shots live
    "summary"  -> session saved, history shown

  New in version 2:
    - Camera settings: zoom, brightness, lock brightness, movement sensitivity
    - "Show what the app sees" view for checking detection at the court
    - Processes every camera frame (up to 60 per second) using requestVideoFrameCallback
    - Predicts where the ball will be next, so it follows the right object
*/

// ---------- 1. Grab the elements from index.html ----------
const $ = (id) => document.getElementById(id);
const video = $("camera");
const overlay = $("overlay");
const ctx = overlay.getContext("2d");

// ---------- 2. App state ----------
let step = "start";
let hoop = null;                  // { x, y, w, h } normalised rim box
let dragStart = null;
let dragNow = null;
const detector = new BallDetector();
let shots = null;
let session = null;
let lastBall = null;              // latest detected ball (for drawing)
const trail = [];
let lastProcessed = 0;
let bannerTimer = null;
let audio = null;
let wakeLock = null;

// For predicting where the ball goes next: the last two sightings and their times.
let seenA = null;                 // older sighting  { x, y, t }
let seenB = null;                 // newest sighting { x, y, t }

// The camera itself.
let track = null;                 // the video "track" of the camera stream
let caps = {};                    // what this camera allows us to change (zoom, exposure...)
let startingCamera = false;       // true while waiting for the camera (stops double-taps)
let hoopAspect = 0;               // picture width/height when the rim was marked (detects rotation)
let settingsOpen = false;         // true while the camera settings sheet is showing
let panelWasOpen = false;         // was the setup panel showing before settings opened?
let stepBeforeLost = null;        // which step we were on when the camera stopped

const HISTORY_KEY = "shot-tracker-history";

// ---------- 3. Helpers (screen <-> picture positions, panels, sound, storage) ----------

function videoRect() {
  const sw = overlay.clientWidth, sh = overlay.clientHeight;
  const vw = video.videoWidth || 16, vh = video.videoHeight || 9;
  const scale = Math.min(sw / vw, sh / vh);
  const w = vw * scale, h = vh * scale;
  return { x: (sw - w) / 2, y: (sh - h) / 2, w, h };
}

function toNorm(px, py) {
  const r = videoRect();
  return {
    x: Math.min(1, Math.max(0, (px - r.x) / r.w)),
    y: Math.min(1, Math.max(0, (py - r.y) / r.h)),
  };
}

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

function showPanel({ label, title, text, primary, secondary }) {
  // While settings are open the panel stays hidden; it comes back when they close.
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
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && step === "tracking") keepScreenOn();
});

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; } catch (e) { return []; }
}
function saveHistory(list) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list)); } catch (e) { /* ignore */ }
}

// ---------- 4. Camera settings (zoom, brightness, lock) ----------

/*
  Each camera reports what can be changed with track.getCapabilities().
  For example caps.zoom = { min: 1, max: 8, step: 0.1 }.
  We only show a slider if the camera supports that setting.
*/
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
  // "includes" checks if a list contains a value, e.g. ["continuous", "manual"].
  if (caps.exposureMode && caps.exposureMode.includes("manual")) {
    any = true;
    $("lockRow").hidden = false;
  } else {
    $("lockInput").checked = false;
  }
  $("noCameraControls").hidden = any;
}

// Change one camera setting. "advanced" is how the browser accepts camera-specific settings.
async function applyCamera(setting) {
  if (!track) return;
  try {
    await track.applyConstraints({ advanced: [setting] });
  } catch (e) {
    /* this phone refused the setting; keep going */
  }
  detector.resetBackground();     // the picture changed, so the old background is wrong
}

// Lock (or unlock) the camera's automatic brightness and colour adjustments.
async function setExposureLock(on) {
  if (!track || !caps.exposureMode) return;
  const setting = {};
  const mode = on ? "manual" : "continuous";
  if (caps.exposureMode.includes(mode)) setting.exposureMode = mode;
  if (caps.whiteBalanceMode && caps.whiteBalanceMode.includes(mode)) setting.whiteBalanceMode = mode;
  // Manual mode keeps the CURRENT exposure time, so the picture doesn't jump.
  const current = track.getSettings();
  if (on && caps.exposureTime && current.exposureTime) setting.exposureTime = current.exposureTime;
  await applyCamera(setting);
}

// Sensitivity slider 1-10 -> how much a pixel must change (lower number = more sensitive).
function applySensitivity() {
  const level = Number($("sensInput").value);
  detector.sensitivity = 37 - level * 3;          // level 5 -> 22, level 10 -> 7
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

/*
  FIX (bug 1): tapping Camera twice used to hide the setup panel for good.
  Now the Camera button hides itself while the sheet is open, and we never
  "open" the sheet a second time, so we always remember the panel correctly.
*/
function openSettings() {
  if (settingsOpen) return;                 // already open: do nothing
  settingsOpen = true;
  // Zoom changes where the rim is on screen, so only allow it before the rim is marked.
  const zoomAllowed = step === "rim";
  $("zoomInput").disabled = !zoomAllowed;
  $("zoomNote").textContent = zoomAllowed
    ? "Zoom in so the hoop looks bigger, then mark the rim."
    : "Zoom is locked after you mark the rim. Use Redo setup to change it.";
  panelWasOpen = !$("panel").hidden;        // remember, then hide the panel underneath
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

// ---------- 5. The steps ----------

/*
  Turn the camera on. Returns true if it worked.
  Used by "Start camera" and by "Restart camera" after the phone stopped it.
*/
async function openCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showError("This browser can't use the camera here. Open the app from its https:// link.");
    return false;
  }
  // If an old camera stream exists, switch it off first so we never run two.
  if (video.srcObject) {
    video.srcObject.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  }
  try {
    // Ask for a sharp picture (up to 1920x1080) and up to 60 frames per second.
    // "ideal" means "if possible": phones that can't, give their best instead.
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
    // FIX (bug 3): if the phone stops the camera (other app, screen lock), tell us.
    track.addEventListener("ended", cameraLost);
    await video.play();
  } catch (err) {
    if (err.name === "NotAllowedError") {
      showError("Camera permission was blocked. Allow camera access for this site in your browser settings, then reload.");
    } else {
      showError("Couldn't start the camera: " + err.message);
    }
    return false;
  }
  setupCameraControls();
  applySensitivity();
  resizeCanvas();
  return true;
}

async function startCamera() {
  // FIX (bug 4): ignore extra taps while we're already waiting for the camera.
  if (startingCamera) return;
  startingCamera = true;
  $("primaryBtn").disabled = true;
  const ok = await openCamera();
  startingCamera = false;
  $("primaryBtn").disabled = false;
  if (!ok) return;
  if (!audio) {
    try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { audio = null; }
  }
  $("settingsBtn").hidden = false;
  goToRim();
}

/*
  FIX (bug 3): the camera stopped (ended), or the picture froze.
  Pause everything and offer a Restart button. The score so far is kept.
*/
function cameraLost() {
  if (step === "start" || step === "lost" || step === "summary") return;
  stepBeforeLost = step;
  step = "lost";
  $("ballStatus").hidden = true;
  closeSettings();
  $("controls").hidden = true;
  $("settingsBtn").hidden = true;
  showPanel({
    label: "Paused",
    title: "Camera stopped",
    text: "Your phone switched the camera off (another app, or the screen locked). Your score so far is kept. Keep the phone in the same place and restart.",
    primary: "Restart camera",
  });
}

async function restartCamera() {
  if (startingCamera) return;
  startingCamera = true;
  $("primaryBtn").disabled = true;
  const ok = await openCamera();
  startingCamera = false;
  $("primaryBtn").disabled = false;
  if (!ok) return;
  $("settingsBtn").hidden = false;
  const turned = hoop && Math.abs(video.videoWidth / video.videoHeight - hoopAspect) > 0.05;
  if (stepBeforeLost === "tracking" && hoop && !turned) {
    startTracking();                     // carry on with the same score
  } else if (stepBeforeLost === "ready" && hoop && !turned) {
    goToReady();
  } else if (stepBeforeLost === "summary") {
    step = "summary";
    $("panel").hidden = true;
    $("summary").hidden = false;
  } else {
    goToRim();
  }
}

// If the page comes back into view and the camera is paused or gone, react.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || step === "start" || step === "lost") return;
  if (!track || track.readyState === "ended") {
    cameraLost();
  } else if (video.paused) {
    video.play().catch(() => cameraLost());   // try to un-freeze the picture
  }
});

/*
  FIX (bug 5): the phone was rotated after the rim was marked.
  The video's "resize" event fires when the picture's width/height change.
*/
video.addEventListener("resize", () => {
  if (!hoop || !video.videoWidth || step === "lost") return;
  const aspect = video.videoWidth / video.videoHeight;
  if (Math.abs(aspect - hoopAspect) > 0.05) {
    closeSettings();
    $("controls").hidden = true;
    goToRim();
    showError("The picture turned (phone rotated). Mark the rim again. Your score so far is kept.");
  }
});

function goToRim() {
  step = "rim";
  hoop = null;
  $("ballStatus").hidden = true;
  $("swatchRow").hidden = true;
  $("panel").classList.remove("top");
  showPanel({
    label: "Step 1 of 2",
    title: "Mark the rim",
    text: "Far from the hoop? Tap Camera and zoom in first. Then drag a box tightly around the rim. Keep the phone still from now on.",
    primary: null,
    secondary: "Move this panel up",       // FIX (bug 7): uncover the bottom of the picture
  });
}

function goToBall() {
  step = "ball";
  showPanel({
    label: "Step 2 of 2",
    title: "Ball colour (optional)",
    text: "The app finds the ball by its size, shape and movement. If other things often move near the hoop, tap the ball so it also checks the colour.",
    primary: null,
    secondary: "Skip",
  });
  $("swatchRow").hidden = true;
}

function goToReady() {
  step = "ready";
  // NEW (version 2.2): start detecting now, without counting, so you can test it.
  if (video.videoWidth) detector.setHoop(hoop, video.videoWidth, video.videoHeight);
  trail.length = 0;
  showPanel({
    label: "Ready",
    title: "Test, then start",
    text: "Test first: throw the ball up near the hoop. A green circle and \"Ball seen\" mean the app can see it. Nothing is counted until you press Start tracking.",
    primary: "Start tracking",
    secondary: "Redo setup",
  });
}

// Show "Ball seen" for a moment after each sighting, so it doesn't flicker.
let lastSeenAt = -Infinity;
function updateBallStatus(ball, now) {
  if (ball) lastSeenAt = now;
  const seen = now - lastSeenAt < 400;
  const el = $("ballStatus");
  el.hidden = !(step === "ready" || step === "tracking");
  el.textContent = seen ? "Ball seen" : "Looking for the ball";
  el.classList.toggle("seen", seen);       // adds the class if seen, removes it if not
}

function startTracking() {
  if (!video.videoWidth) { cameraLost(); return; }   // no picture: can't track
  step = "tracking";
  // Keep the score if we're coming back from a camera restart or a rotation.
  // "New session" sets session to null, so a fresh one starts there.
  if (!session) session = new Session();
  shots = new ShotDetector(hoop);
  detector.setHoop(hoop, video.videoWidth, video.videoHeight);   // work out the tracking zone
  trail.length = 0;
  seenA = seenB = null;
  closeSettings();
  $("panel").hidden = true;
  $("scoreboard").hidden = false;
  $("controls").hidden = false;
  updateScoreboard();
  keepScreenOn();
  if ($("lockInput").checked) setExposureLock(true);
}

function endSession() {
  step = "summary";
  const list = loadHistory();
  if (session.attempted > 0) {
    list.unshift(session.toRecord());
    saveHistory(list.slice(0, 30));
  }
  closeSettings();
  $("ballStatus").hidden = true;
  $("controls").hidden = true;
  $("scoreboard").hidden = true;
  $("summaryTitle").textContent =
    `${session.made}/${session.attempted} · ${session.percentage.toFixed(1)}%`;
  renderHistory(loadHistory());
  $("summary").hidden = false;
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  setExposureLock(false);
}

function renderHistory(list) {
  const body = $("historyBody");
  body.textContent = "";
  if (list.length === 0) {
    const cell = body.insertRow().insertCell();
    cell.colSpan = 4;
    cell.textContent = "No sessions yet.";
    return;
  }
  for (const s of list.slice(0, 10)) {
    const row = body.insertRow();
    const pct = s.attempted ? (s.made / s.attempted) * 100 : 0;
    const date = new Date(s.date).toLocaleDateString(undefined, { day: "numeric", month: "short" });
    for (const value of [date, s.made, s.attempted, pct.toFixed(1)]) {
      row.insertCell().textContent = value;
    }
  }
}

// ---------- 6. Scoring ----------

function updateScoreboard() {
  $("fgValue").textContent = session.percentage.toFixed(1);
  $("madeValue").textContent = session.made;
  $("missValue").textContent = session.attempted - session.made;
  $("shotsValue").textContent = session.attempted;
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
  session.record(result === "make");
  updateScoreboard();
  showBanner(result);
  beep(result === "make" ? 880 : 220);
  if (navigator.vibrate) navigator.vibrate(result === "make" ? 80 : [40, 60, 40]);
}

// ---------- 7. Processing one camera frame ----------

/*
  Where should the ball be now? If we saw it twice recently, assume it keeps
  moving the same way: position + velocity x time. Returns null if we don't know.
*/
function predict(now) {
  if (!seenA || !seenB || now - seenB.t > 300) return null;
  const dt = seenB.t - seenA.t;
  if (dt <= 0) return null;
  const k = (now - seenB.t) / dt;
  return { x: seenB.x + (seenB.x - seenA.x) * k, y: seenB.y + (seenB.y - seenA.y) * k };
}

function processFrame(now) {
  // Detect in the Ready step (test only) and while tracking (counting).
  if (step !== "tracking" && step !== "ready") {
    $("ballStatus").hidden = true;
    return;
  }
  const ball = detector.detect(video, predict(now));
  lastBall = ball;
  if (ball) {
    seenA = seenB;
    seenB = { x: ball.x, y: ball.y, t: now };
    trail.push(ball);
    if (trail.length > 20) trail.shift();
  }
  updateBallStatus(ball, now);
  if (step !== "tracking") return;         // Ready step: test only, don't count
  const result = shots.update(now, ball ? { x: ball.x, y: ball.y } : null);
  if (result) onShot(result);
}

// requestVideoFrameCallback runs our code once for EVERY new camera frame
// (up to 60 per second), never twice for the same frame. Most phones support it.
const hasFrameCallback = "requestVideoFrameCallback" in HTMLVideoElement.prototype;
function onVideoFrame(now) {
  processFrame(now);
  video.requestVideoFrameCallback(onVideoFrame);
}
if (hasFrameCallback) video.requestVideoFrameCallback(onVideoFrame);

// The drawing loop. If the phone lacks requestVideoFrameCallback, process here instead.
function tick(now) {
  if (!hasFrameCallback && now - lastProcessed >= 16) {
    lastProcessed = now;
    processFrame(now);
  }
  draw();
  requestAnimationFrame(tick);
}

// ---------- 8. Drawing ----------

function draw() {
  ctx.clearRect(0, 0, overlay.clientWidth, overlay.clientHeight);

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

  // Detection view: the tracking zone and every candidate the detector found.
  // Always shown in the Ready (test) step; while tracking only if switched on.
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
      const [bx, by, bw, bh] = c.box;              // box in zone pixels
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

// ---------- 9. Touch input on the camera view ----------

overlay.addEventListener("pointerdown", (e) => {
  // FIX (bug 2): while the settings sheet is open, touches on the picture do nothing.
  if (settingsOpen) return;
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
  hoopAspect = video.videoWidth / video.videoHeight;   // remember the picture shape (bug 5)
  goToBall();
});

// FIX (bug 6): the phone interrupted the drag (system gesture, notification...).
// Throw the half-drawn box away instead of leaving it stuck on screen.
function cancelDrag() {
  dragStart = dragNow = null;
}
overlay.addEventListener("pointercancel", cancelDrag);
overlay.addEventListener("lostpointercapture", () => {
  // Capture is also released after a normal pointerup, which already cleared the drag.
  if (dragStart) cancelDrag();
});

// ---------- 10. Buttons ----------

$("primaryBtn").addEventListener("click", () => {
  if (step === "start") startCamera();
  else if (step === "ready") startTracking();
  else if (step === "lost") restartCamera();
});

$("secondaryBtn").addEventListener("click", () => {
  if (step === "rim") {
    // FIX (bug 7): flip the panel between the bottom and the top of the screen.
    const top = $("panel").classList.toggle("top");   // toggle returns true if now "top"
    $("secondaryBtn").textContent = top ? "Move this panel down" : "Move this panel up";
  } else if (step === "ball") {
    detector.mode = "shape";           // skip colour: shape + movement only
    goToReady();
  } else if (step === "ready") {
    goToRim();
  }
});

$("undoBtn").addEventListener("click", () => { session.undo(); updateScoreboard(); });
$("flipBtn").addEventListener("click", () => { session.flipLast(); updateScoreboard(); });
$("addMakeBtn").addEventListener("click", () => onShot("make"));
$("addMissBtn").addEventListener("click", () => onShot("miss"));
$("endBtn").addEventListener("click", endSession);
$("againBtn").addEventListener("click", () => {
  $("summary").hidden = true;
  session = null;                        // a brand-new score for the next session
  goToReady();
});

// ---------- 11. Go! ----------
resizeCanvas();
requestAnimationFrame(tick);
