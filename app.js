// Embodied Orchestra — first PoC
// Audio: Tone.js synthesized "string-like" voice (sustains indefinitely).
// Upgrade path: swap MonoSynth for a Tone.Sampler loading SoundFont violin samples
// (e.g. tonejs-instruments) once mappings are validated.

const screens = {
  desktop:    document.getElementById('desktop-fallback'),
  permission: document.getElementById('permission-screen'),
  mode:       document.getElementById('mode-screen'),
  play:       document.getElementById('play-screen'),
};

function show(name) {
  Object.entries(screens).forEach(([k, el]) => {
    el.classList.toggle('hidden', k !== name);
  });
}

// iPads on iPadOS 13+ report as "Mac" — disambiguate via touch points.
const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
  || (navigator.maxTouchPoints > 1 && /Mac|Macintosh/.test(navigator.platform));

show(isMobile ? 'permission' : 'desktop');

// ---------- Audio ----------
let synth, vibrato, reverb, filter;
let audioReady = false;

async function initAudio() {
  await Tone.start();

  reverb  = new Tone.Reverb({ decay: 2.5, wet: 0.25 }).toDestination();
  vibrato = new Tone.Vibrato({ frequency: 5.5, depth: 0 }).connect(reverb);
  filter  = new Tone.Filter(2400, 'lowpass').connect(vibrato);

  synth = new Tone.MonoSynth({
    oscillator: { type: 'fatsawtooth', count: 3, spread: 28 },
    envelope:        { attack: 0.35, decay: 0.0, sustain: 1.0, release: 0.9 },
    filterEnvelope:  { attack: 0.4,  decay: 0.0, sustain: 1.0, release: 0.9,
                       baseFrequency: 220, octaves: 3.5 },
  });
  synth.volume.value = -10;
  synth.connect(filter);

  audioReady = true;
}

// ---------- Sensor permissions ----------
async function requestSensorPermission() {
  // Modern Chrome/Safari remove these APIs entirely from non-secure origins
  // (HTTP from a non-localhost host), so check for existence before use.
  if (typeof DeviceMotionEvent === 'undefined' || typeof DeviceOrientationEvent === 'undefined') {
    throw new Error('Motion sensors require HTTPS. Deploy to GitHub Pages or use an HTTPS tunnel (ngrok / localtunnel).');
  }
  // iOS 13+ requires explicit user-gesture-driven permission.
  if (typeof DeviceMotionEvent.requestPermission === 'function') {
    const r = await DeviceMotionEvent.requestPermission();
    if (r !== 'granted') return false;
  }
  if (typeof DeviceOrientationEvent.requestPermission === 'function') {
    const r = await DeviceOrientationEvent.requestPermission();
    if (r !== 'granted') return false;
  }
  return true;
}

document.getElementById('enable-btn').addEventListener('click', async () => {
  try {
    const granted = await requestSensorPermission();
    if (!granted) {
      alert('Motion permission was denied. Reload to try again.');
      return;
    }
    await initAudio();
    requestWakeLock();
    show('mode');
  } catch (err) {
    console.error(err);
    alert('Could not start: ' + err.message);
  }
});

// ---------- Sensor state ----------
let heading = 0;          // 0..360 (compass, clockwise from north)
let beta    = 0;          // -180..180, front-back tilt (top of phone tipping away from user)
let gamma   = 0;          // -90..90, side roll
let shakeIntensity = 0;   // smoothed |acceleration| (3D, for vibrato)
let bowSpeed = 0;         // smoothed lateral acceleration (X/Y plane, for bow mode)

function getCompassHeading(e) {
  // iOS Safari: webkitCompassHeading is clockwise from magnetic north (what we want).
  if (e.webkitCompassHeading != null) return e.webkitCompassHeading;
  // Spec: alpha is counter-clockwise from north — invert to match.
  if (e.alpha == null) return heading;
  return (360 - e.alpha + 360) % 360;
}

function onOrientation(e) {
  heading = getCompassHeading(e);
  beta    = e.beta  ?? 0;
  gamma   = e.gamma ?? 0;
  if (currentMode) currentMode.tick();
}

function onMotion(e) {
  const a = e.acceleration;
  if (!a || a.x == null) return;
  const mag = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
  shakeIntensity = shakeIntensity * 0.82 + mag * 0.18;
  // Lateral-only magnitude responds to bow strokes without picking up gravity drift on Z.
  // Lighter smoothing (0.7/0.3) keeps it snappy for the attack/release gate.
  const lateral = Math.sqrt(a.x * a.x + a.y * a.y);
  bowSpeed = bowSpeed * 0.7 + lateral * 0.3;
  if (audioReady) {
    vibrato.depth.value = Math.min(0.6, shakeIntensity / 18);
  }
}

window.addEventListener('deviceorientation', onOrientation);
window.addEventListener('devicemotion', onMotion);

// ---------- Modes ----------
const PENTATONIC = ['C4', 'D4', 'E4', 'G4', 'A4', 'C5', 'D5', 'E5'];
// Wider ladder for theremin: 2.5 octaves of A-minor pentatonic so tilt has range.
const THEREMIN_SCALE = ['C3','D3','E3','G3','A3','C4','D4','E4','G4','A4','C5','D5','E5'];

function headingToNote(h) {
  const idx = Math.floor((h / 360) * PENTATONIC.length) % PENTATONIC.length;
  return PENTATONIC[idx];
}

const els = {
  note:    document.getElementById('note-display'),
  tilt:    document.getElementById('tilt-bar'),
  shake:   document.getElementById('shake-bar'),
  status:  document.getElementById('status'),
};

function setStatus(text, playing = false) {
  els.status.textContent = text;
  els.status.classList.toggle('playing', playing);
}

const modes = {
  // Conductor: heading picks a note from the pentatonic ladder; forward tilt = play.
  // Hysteresis (30° to play, 15° to release) keeps the note from chattering at threshold.
  compass: {
    enter() {
      this.lastNote = null;
      this.playing  = false;
      setStatus('turn to choose · tilt forward to play');
    },
    tick() {
      const note = headingToNote(heading);
      const PLAY = 30, RELEASE = 15;

      const tiltPct = Math.min(1, Math.max(0, (beta - RELEASE) / (PLAY - RELEASE)));
      els.tilt.style.width  = (tiltPct * 100) + '%';
      els.shake.style.width = Math.min(100, shakeIntensity * 5) + '%';
      els.note.textContent  = note;

      if (!this.playing && beta > PLAY) {
        synth.triggerAttack(note);
        this.lastNote = note;
        this.playing  = true;
        setStatus('playing', true);
      } else if (this.playing && beta < RELEASE) {
        synth.triggerRelease();
        this.playing = false;
        setStatus('released');
      } else if (this.playing && note !== this.lastNote) {
        synth.setNote(note);
        this.lastNote = note;
      }
    },
    leave() {
      synth.triggerRelease();
      this.playing = false;
    },
  },

  // Theremin: tilt picks a band on the pentatonic ladder; side lean gates/scales volume.
  // Pitch glides between bands (~120 ms portamento) so transitions feel like a slide,
  // not a step — closer to a real theremin's continuous voice while staying in key.
  theremin: {
    enter() {
      this.playing  = false;
      this.bandIdx  = -1;
      setStatus('tilt to climb scale · lean for volume');
    },
    tick() {
      const t    = Math.max(0, Math.min(1, (beta + 45) / 90));
      const idx  = Math.min(THEREMIN_SCALE.length - 1, Math.floor(t * THEREMIN_SCALE.length));
      const note = THEREMIN_SCALE[idx];
      const freq = Tone.Frequency(note).toFrequency();
      const lean = Math.max(0, Math.min(1, Math.abs(gamma) / 60));

      els.tilt.style.width  = (t * 100) + '%';
      els.shake.style.width = Math.min(100, shakeIntensity * 5) + '%';
      els.note.textContent  = note;

      if (lean > 0.18 && !this.playing) {
        synth.frequency.value = freq;
        synth.triggerAttack(note);
        this.bandIdx = idx;
        this.playing = true;
        setStatus('playing', true);
      } else if (lean < 0.08 && this.playing) {
        synth.triggerRelease();
        this.playing = false;
        setStatus('released');
      }
      if (this.playing) {
        if (idx !== this.bandIdx) {
          synth.frequency.rampTo(freq, 0.12);
          this.bandIdx = idx;
        }
        synth.volume.rampTo(-22 + lean * 14, 0.05);
      }
    },
    leave() {
      synth.triggerRelease();
      this.playing = false;
    },
  },

  // Bow: heading picks the note (like Conductor); lateral phone motion is the bow stroke.
  // Hysteresis on bow speed (2.0 m/s² to attack, 0.6 to release) avoids re-triggering
  // between strokes; volume tracks bow energy so soft strokes are quieter.
  bow: {
    enter() {
      this.playing  = false;
      this.lastNote = null;
      setStatus('turn to choose · move side-to-side to bow');
    },
    tick() {
      const note   = headingToNote(heading);
      const BOW_ON = 2.0, BOW_OFF = 0.6;
      const bowPct = Math.min(1, bowSpeed / 5);

      els.tilt.style.width  = (bowPct * 100) + '%';
      els.shake.style.width = Math.min(100, shakeIntensity * 5) + '%';
      els.note.textContent  = note;

      if (!this.playing && bowSpeed > BOW_ON) {
        synth.triggerAttack(note);
        this.lastNote = note;
        this.playing  = true;
        setStatus('playing', true);
      } else if (this.playing && bowSpeed < BOW_OFF) {
        synth.triggerRelease();
        this.playing = false;
        setStatus('released');
      } else if (this.playing && note !== this.lastNote) {
        synth.setNote(note);
        this.lastNote = note;
      }
      if (this.playing) {
        synth.volume.rampTo(-22 + bowPct * 14, 0.05);
      }
    },
    leave() {
      synth.triggerRelease();
      this.playing = false;
    },
  },
};

let currentMode = null;

document.querySelectorAll('.mode-btn:not(.disabled)').forEach(btn => {
  btn.addEventListener('click', () => {
    if (Tone.context.state !== 'running') Tone.context.resume();
    currentMode = modes[btn.dataset.mode];
    show('play');
    currentMode.enter();
  });
});

document.getElementById('back-btn').addEventListener('click', () => {
  if (currentMode) currentMode.leave();
  currentMode = null;
  setStatus('ready');
  show('mode');
});

// ---------- Wake lock ----------
let wakeLock = null;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch (_) { /* ignore — not supported on all browsers */ }
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) requestWakeLock();
});
