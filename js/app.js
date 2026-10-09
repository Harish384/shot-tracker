/*
  app.js - the main app. Connects the camera, the screens and the detectors.

  The app moves through STEPS, one after another:
    "start"    -> press Start camera
    "rim"      -> drag a box around the rim
    "ball"     -> tap the ball to learn its colour (or skip to use orange)
    "ready"    -> press Start tracking
    "tracking" -> counting shots live
    "summary"  -> session saved, history shown

  Every frame while tracking:
    camera -> BallDetector (where is the ball?) -> ShotDetector (make/miss?)
           -> Session (update score) -> draw on screen
*/

// ---------- 1. Grab the elements from index.html by their id ----------
// document.getElementById finds the element with that id="..."
const $ = (id) => document.getElementById(id);   // a tiny shortcut function
const video = $("camera");
const overlay = $("overlay");
const ctx = overlay.getContext("2d");            // the "pen" we draw with on the canvas

// ---------- 2. App state: everything the app needs to remember ----------
let step = "start";
let hoop = null;                  // { x, y, w, h } normalised rim box
let dragStart = null;             // where the finger went down while drawing the box
let dragNow = null;               // where the finger is now
const detector = new BallDetector();
let shots = null;                 // ShotDetector, created when tracking starts
let session = null;               // Session, created when tracking starts
let lastBall = null;              // latest ball position, for drawing
const trail = [];                 // recent ball positions
let lastProcessed = 0;            // time of the last analysed frame
let bannerTimer = null;
let audio = null;                 // sound player, created on the first button press
let wakeLock = null;              // keeps the screen on

const HISTORY_KEY = "shot-tracker-history";

// ---------- 3. Small helpers ----------

/*
  The camera picture is shown with "object-fit: contain", so there may be black
  bars. This works out where the picture actually sits on the screen, so we can
  convert between screen positions and normalised (0-1) picture positions.
*/
function videoRect() {
  const sw = overlay.clientWidth, sh = overlay.clientHeight;   // screen size
  const vw = video.videoWidth || 16, vh = video.videoHeight || 9; // camera size
  const scale = Math.min(sw / vw, sh / vh);
  const w = vw * scale, h = vh * scale;
  return { x: (sw - w) / 2, y: (sh - h) / 2, w, h };
}

// Screen point (px) -> normalised picture point (0-1)
function toNorm(px, py) {
  const r = videoRect();
  return {
    x: Math.min(1, Math.max(0, (px - r.x) / r.w)),   // min/max "clamp" it to 0-1
    y: Math.min(1, Math.max(0, (py - r.y) / r.h)),
  };
}

// Normalised picture point -> screen point
function toScreen(nx, ny) {
  const r = videoRect();
  return { x: r.x + nx * r.w, y: r.y + ny * r.h };
}

// Make the canvas match the screen size (and the phone's pixel density, for sharp lines).
function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  overlay.width = overlay.clientWidth * dpr;
  overlay.height = overlay.clientHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);   // so we can draw in normal screen units
}
window.addEventListener("resize", resizeCanvas);

// Show the setup panel with new text and buttons.
function showPanel({ label, title, text, primary, secondary }) {
  $("panel").hidden = false;
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

// A short beep using the Web Audio API. High pitch = make, low = miss.
function beep(freq) {
  if (!audio) return;
  const osc = audio.createOscillator();     // makes a tone
  const gain = audio.createGain();          // controls the volume
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.2, audio.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.25); // fade out
  osc.connect(gain).connect(audio.destination);
  osc.start();
  osc.stop(audio.currentTime + 0.25);
}

// Ask the phone to keep the screen on. Not all phones allow it, so ignore errors.
async function keepScreenOn() {
  try {
    if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
  } catch (e) { /* not allowed: the screen may dim, the app still works */ }
}
// The lock is released when you switch apps, so ask again when you come back.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && step === "tracking") keepScreenOn();
});

// Saved sessions live in the phone browser's localStorage (stays after closing the tab).
function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY)) || [];
  } catch (e) {
    return [];      // storage blocked or broken: start empty
  }
}
function saveHistory(list) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list)); } catch (e) { /* ignore */ }
}

// ---------- 4. The steps ----------

// Step "start": turn on the camera.
async function startCamera() {
  // Camera access only works on https:// pages (or localhost), for privacy.
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showError("This browser can't use the camera here. Open the app from its https:// link.");
    return;
  }
  try {
    // getUserMedia asks permission and returns a live camera "stream".
    // facingMode "environment" = the back camera.
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    video.srcObject = stream;               // show the stream in the <video> element
    await video.play();
  } catch (err) {
    if (err.name === "NotAllowedError") {
      showError("Camera permission was blocked. Allow camera access for this site in your browser settings, then reload.");
    } else {
      showError("Couldn't start the camera: " + err.message);
    }
    return;
  }
  // Create the sound player now, because browsers only allow sound after a tap.
  try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { audio = null; }
  resizeCanvas();
  goToRim();
}

function goToRim() {
  step = "rim";
  hoop = null;
  $("swatchRow").hidden = true;
  showPanel({
    label: "Step 1 of 2",
    title: "Mark the rim",
    text: "Drag a box tightly around the rim with your finger. Keep the phone still from now on.",
    primary: null,
  });
}

function goToBall() {
  step = "ball";
  showPanel({
    label: "Step 2 of 2",
    title: "Tap the ball",
    text: "Hold the ball where the camera sees it, then tap it on screen so the app learns its colour.",
    primary: null,
    secondary: "Skip (use orange)",
  });
  $("swatchRow").hidden = true;
}

function goToReady() {
  step = "ready";
  showPanel({
    label: "Ready",
    title: "Start shooting",
    text: "Shots that go higher than the rim are counted. Use Undo or Flip if the app gets one wrong.",
    primary: "Start tracking",
    secondary: "Redo setup",
  });
}

function startTracking() {
  step = "tracking";
  session = new Session();
  shots = new ShotDetector(hoop);
  detector.prevGray = null;
  trail.length = 0;                          // empty the trail
  $("panel").hidden = true;
  $("scoreboard").hidden = false;
  $("controls").hidden = false;
  updateScoreboard();
  keepScreenOn();
}

function endSession() {
  step = "summary";
  const list = loadHistory();
  if (session.attempted > 0) {
    list.unshift(session.toRecord());        // unshift = add to the FRONT of the list
    saveHistory(list.slice(0, 30));          // keep the 30 most recent
  }
  $("controls").hidden = true;
  $("scoreboard").hidden = true;
  $("summaryTitle").textContent =
    `${session.made}/${session.attempted} · ${session.percentage.toFixed(1)}%`;
  renderHistory(loadHistory());
  $("summary").hidden = false;
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}

function renderHistory(list) {
  const body = $("historyBody");
  body.textContent = "";                     // remove old rows
  if (list.length === 0) {
    const row = body.insertRow();
    const cell = row.insertCell();
    cell.colSpan = 4;
    cell.textContent = "No sessions yet.";
    return;
  }
  for (const s of list.slice(0, 10)) {       // show the 10 most recent
    const row = body.insertRow();
    const pct = s.attempted ? (s.made / s.attempted) * 100 : 0;
    const date = new Date(s.date).toLocaleDateString(undefined, { day: "numeric", month: "short" });
    for (const value of [date, s.made, s.attempted, pct.toFixed(1)]) {
      row.insertCell().textContent = value;  // textContent is safe: never runs as code
    }
  }
}

// ---------- 5. Scoring ----------

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
  bannerTimer = setTimeout(() => { banner.hidden = true; }, 1000);  // hide after 1 second
}

function onShot(result) {
  session.record(result === "make");
  updateScoreboard();
  showBanner(result);
  beep(result === "make" ? 880 : 220);
  if (navigator.vibrate) navigator.vibrate(result === "make" ? 80 : [40, 60, 40]);
}

// ---------- 6. The main loop: runs about 60 times a second ----------

function tick(now) {
  // Analyse at most ~30 frames per second, so slower phones keep up.
  if (step === "tracking" && now - lastProcessed >= 33) {
    lastProcessed = now;
    const ball = detector.detect(video);
    lastBall = ball;
    if (ball) {
      trail.push(ball);
      if (trail.length > 20) trail.shift();  // shift = remove the oldest
    }
    const result = shots.update(now, ball ? { x: ball.x, y: ball.y } : null);
    if (result) onShot(result);
  }
  draw();
  requestAnimationFrame(tick);               // ask the browser to call tick again next frame
}

// Draw the rim box, drag box, ball and trail.
function draw() {
  ctx.clearRect(0, 0, overlay.clientWidth, overlay.clientHeight);

  // The box being dragged right now.
  if (step === "rim" && dragStart && dragNow) {
    ctx.strokeStyle = "#ffb020";
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);                 // dashed line
    ctx.strokeRect(dragStart.x, dragStart.y, dragNow.x - dragStart.x, dragNow.y - dragStart.y);
    ctx.setLineDash([]);
  }

  // The saved rim box, with the rim line through its middle.
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

  if (step !== "tracking") return;

  // Trail dots.
  ctx.fillStyle = "rgba(255, 255, 255, 0.75)";
  for (const p of trail) {
    const s = toScreen(p.x, p.y);
    ctx.beginPath();
    ctx.arc(s.x, s.y, 3, 0, Math.PI * 2);    // a full circle is 2*pi radians
    ctx.fill();
  }

  // Circle around the ball.
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

// ---------- 7. Touch / mouse input on the camera view ----------
// "pointer" events work for both fingers and mice.

overlay.addEventListener("pointerdown", (e) => {
  if (step === "rim") {
    dragStart = { x: e.offsetX, y: e.offsetY };
    dragNow = dragStart;
    overlay.setPointerCapture(e.pointerId);  // keep getting moves even if the finger leaves
  } else if (step === "ball") {
    const p = toNorm(e.offsetX, e.offsetY);
    const colour = detector.sampleColour(video, p.x, p.y);
    if (colour) {
      $("swatch").style.background = colour;
      $("swatchText").textContent = "Got the ball colour.";
      $("swatchRow").hidden = false;
      goToReadyAfterBall();
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
  if (b.x - a.x < 0.01 || b.y - a.y < 0.005) {
    showError("That box is too small. Drag across the whole rim.");
    return;
  }
  hoop = { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
  goToBall();
});

// Keep the colour swatch visible on the Ready screen.
function goToReadyAfterBall() {
  goToReady();
  $("swatchRow").hidden = false;
}

// ---------- 8. Buttons ----------

$("primaryBtn").addEventListener("click", () => {
  if (step === "start") startCamera();
  else if (step === "ready") startTracking();
});

$("secondaryBtn").addEventListener("click", () => {
  if (step === "ball") {
    detector.targetHue = 25;                 // default orange
    $("swatchRow").hidden = true;
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
  goToReady();                               // same phone position: keep the rim box
});

// ---------- 9. Go! ----------
resizeCanvas();
requestAnimationFrame(tick);
