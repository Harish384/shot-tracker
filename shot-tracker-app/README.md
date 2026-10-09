# Shot Tracker

A phone web app that watches you shoot through the phone's camera and counts your
makes, misses and shooting percentage live. No app store, no server: it runs in the
phone's browser.

## How it works (version 2)

```
phone camera (live, up to 60 frames per second)
  -> js/ballDetector.js   looks only at a zone around the hoop, in high detail;
                          the ball = something MOVING, ball-SIZED (measured
                          against the rim) and ROUND or a short blurred streak.
                          Colour is an optional extra check.
  -> js/shotDetector.js   ball rises above the rim, then comes down past it:
                          crossed inside the rim = MAKE, outside = MISS
  -> js/session.js        keeps the score
  -> js/app.js            screens, camera settings, drawing, the main loop
```

### What changed in version 2 (after court testing)

| Problem found at the court | Fix |
|---|---|
| Far-away ball too small to see | Analyse only the zone around the hoop, at up to 320 px wide instead of the whole picture at 192 px. The ball looks about 5x bigger to the app. |
| Other things with the ball's colour | Detect by movement + size + shape. Colour is optional. Things far from the hoop are outside the zone and ignored. |
| Phone changes brightness by itself | Camera settings: brightness slider and "Lock brightness while tracking". The detector also restarts its background picture after a sudden light jump. |
| Fast ball at a distance | 60 fps camera, every frame processed, blurred streaks accepted, and the app predicts where the ball goes next. |

Tested on generated footage with a small far hoop, a pale ball, a bright wall,
drifting brightness, fast blurred shots and a person in an orange shirt:
version 1 found 0 of 6 makes, version 2 judged all 10 shots correctly.

## Files

| File | What it does |
|---|---|
| `index.html` | What's on screen: camera view, scoreboard, setup panel, camera settings, buttons |
| `style.css` | How it looks |
| `js/session.js` | Score keeping: record, undo, flip, percentage |
| `js/ballDetector.js` | Finds the ball near the hoop in each camera frame |
| `js/shotDetector.js` | Decides make or miss from the ball's path |
| `js/app.js` | Runs everything: setup steps, camera settings, main loop, drawing, history |

## Put it on your phone (free, with GitHub Pages)

The camera only works on `https://` pages, and GitHub Pages gives you one for free.

1. On github.com, click **New repository**, name it `shot-tracker`, make it **Public**, click **Create**.
2. In VS Code's terminal, inside this folder:
   ```
   git init
   git add .
   git commit -m "Shot tracker phone app"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/shot-tracker.git
   git push -u origin main
   ```
3. On the repository page: **Settings**, then **Pages**. Under "Branch" pick `main` and `/ (root)`, then **Save**.
4. Wait 1-2 minutes. Your app is at `https://YOUR-USERNAME.github.io/shot-tracker/`.
5. Open that link on your phone and allow camera access. Use "Add to Home screen" so it opens like an app.

After any change: `git add .`, `git commit -m "..."`, `git push`, and the site updates in a minute.
If your phone still shows the old version, close the tab and reopen the link.

## Test on your laptop first

```
python -m http.server 8000
```
Then open `http://localhost:8000` in Chrome. It uses your webcam (localhost is allowed).

## At the court

1. Put the phone at the side of the court, steady, in **landscape**, so it sees you **and**
   plenty of air above the hoop. Avoid having bright sky or a bright opening right behind the hoop.
2. **Start camera**. If the hoop looks small, tap **Camera** and zoom in until the hoop and the
   space above it fill a good part of the screen.
3. Drag a tight box around the rim.
4. Optional: tap the ball to switch on the colour check, or **Skip**.
5. **Start tracking** and shoot. The phone beeps high for a make, low for a miss.
6. Not detecting the ball? Tap **Camera**, turn on **Show what the app sees**, and raise
   **Movement sensitivity**. Seeing lots of red boxes? Lower it.
7. **Undo** / **Flip last** fix mistakes. **+ Make** / **+ Miss** add a shot by hand.
8. **End** saves the session; your last 10 sessions are shown.

## Limits to know

- Shots must go higher than the rim to count.
- The phone must not move after you mark the rim.
- Zoom, brightness and lock depend on the phone: they work in Chrome on most Android phones;
  iPhones usually don't allow them.
- People moving right next to the hoop (layups, rebounding) can create false detections.
- A ball that bounces high off the rim and drops in later may be judged wrong: use Flip.
- Sessions are stored on that phone's browser only.
