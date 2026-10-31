/**
 * ElysaPay's sound, from the ancient world, all synthesised in the browser (no audio files, nothing downloaded):
 *
 * - **Lyre strings** (Karplus–Strong plucked-string synthesis) for taps, opening a review and sending, tuned to the
 *   Dorian mode on D, the mode the Greeks named.
 * - **A bronze bell** (inharmonic partials with long tails) for a confirmed payment and the hero's strike.
 * - **Elysian ambience**, off by default: a low drone on D and A with a lyre that plays a few notes now and then.
 * - **A voice** that reads each review aloud with the browser's speech synthesis, off by default.
 *
 * Every choice is per viewer and kept in localStorage. Cues are on by default and sit well under a notification's
 * level; nothing depends on sound, every cue accompanies text that says the same thing.
 */
export type Cue = "tap" | "hover" | "send" | "success" | "error" | "morph" | "open" | "chime" | "bell";

const SOUND_KEY = "elysapay.sound";
const VOICE_KEY = "elysapay.voice";
const MUSIC_KEY = "elysapay.music";
const listeners = new Set<() => void>();

const read = (key: string, fallback: boolean) => {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value === "on";
  } catch {
    return fallback;
  }
};
const write = (key: string, on: boolean) => {
  try {
    localStorage.setItem(key, on ? "on" : "off");
  } catch {
    // Private mode: the choice lasts for this page only.
  }
};

const browser = typeof window !== "undefined";
let soundOn = browser ? read(SOUND_KEY, true) : false;
let voiceOn = browser ? read(VOICE_KEY, false) : false;
let musicOn = browser ? read(MUSIC_KEY, false) : false;
let context: AudioContext | undefined;
let master: GainNode | undefined;
let reverbSend: GainNode | undefined;
let unlocked = false;

export const soundEnabled = () => soundOn;
export const voiceEnabled = () => voiceOn;
export const musicEnabled = () => musicOn;
export const voiceAvailable = () => browser && "speechSynthesis" in window;
const notify = () => listeners.forEach((listener) => listener());

export function setSound(on: boolean) {
  soundOn = on;
  write(SOUND_KEY, on);
  if (on) playCue("chime");
  notify();
}

export function setVoice(on: boolean) {
  voiceOn = on;
  write(VOICE_KEY, on);
  if (!on && voiceAvailable()) window.speechSynthesis.cancel();
  if (on) speak("Voice on. ElysaPay will read each review aloud.");
  notify();
}

export function setMusic(on: boolean) {
  musicOn = on;
  write(MUSIC_KEY, on);
  if (on) startMusic();
  else stopMusic();
  notify();
}

export function onSoundChange(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** The audio graph, made on first use after an interaction: master → soft low-pass, plus a small stone-hall reverb. */
function graph() {
  if (!unlocked || !browser) return undefined;
  const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Context) return undefined;
  if (!context) {
    context = new Context();
    master = context.createGain();
    master.gain.value = 0.5;
    const tone = context.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.value = 6000;
    master.connect(tone).connect(context.destination);
    // A short synthetic impulse: the sound of a marble hall.
    const convolver = context.createConvolver();
    const length = Math.floor(context.sampleRate * 1.8);
    const impulse = context.createBuffer(2, length, context.sampleRate);
    for (let channel = 0; channel < 2; channel++) {
      const data = impulse.getChannelData(channel);
      for (let index = 0; index < length; index++) data[index] = (Math.random() * 2 - 1) * Math.pow(1 - index / length, 3.2);
    }
    convolver.buffer = impulse;
    reverbSend = context.createGain();
    reverbSend.gain.value = 0.28;
    reverbSend.connect(convolver).connect(tone);
  }
  if (context.state === "suspended") void context.resume();
  return context;
}

const strings = new Map<string, AudioBuffer>();
/** A plucked string by Karplus–Strong: a burst of noise circulating in a delay line that averages as it decays. */
function pluckBuffer(ctx: AudioContext, frequency: number, seconds: number, brightness: number) {
  const key = `${frequency.toFixed(2)}|${seconds}|${brightness}`;
  const cached = strings.get(key);
  if (cached) return cached;
  const rate = ctx.sampleRate;
  const buffer = ctx.createBuffer(1, Math.floor(rate * seconds), rate);
  const data = buffer.getChannelData(0);
  const period = Math.max(2, Math.round(rate / frequency));
  const line = new Float32Array(period);
  for (let index = 0; index < period; index++) line[index] = (Math.random() * 2 - 1) * (0.6 + 0.4 * Math.random());
  // Pre-filter the excitation so the attack is a finger, not a pick.
  for (let index = 1; index < period; index++) line[index] = line[index] * brightness + line[index - 1] * (1 - brightness);
  const damping = 0.996;
  let at = 0;
  for (let index = 0; index < data.length; index++) {
    const next = (at + 1) % period;
    const value = line[at];
    data[index] = value;
    line[at] = damping * 0.5 * (value + line[next]);
    at = next;
  }
  strings.set(key, buffer);
  return buffer;
}

function pluck(ctx: AudioContext, frequency: number, when: number, level = 0.5, seconds = 2.2, brightness = 0.55, pan = 0) {
  const source = ctx.createBufferSource();
  source.buffer = pluckBuffer(ctx, frequency, seconds, brightness);
  const gain = ctx.createGain();
  gain.gain.value = level;
  const panner = ctx.createStereoPanner();
  panner.pan.value = pan;
  source.connect(gain).connect(panner);
  panner.connect(master!);
  panner.connect(reverbSend!);
  source.start(when);
}

/** A bronze bell: inharmonic partials, the higher ones dying first. */
function bell(ctx: AudioContext, frequency: number, when: number, level = 0.32) {
  const partials: Array<[number, number, number]> = [[0.5, 0.35, 4.5], [1, 1, 3.6], [2.0, 0.55, 2.4], [2.76, 0.45, 1.8], [5.4, 0.25, 1.1], [8.93, 0.12, 0.7]];
  for (const [ratio, amplitude, decay] of partials) {
    const oscillator = ctx.createOscillator();
    oscillator.type = "sine";
    oscillator.frequency.value = frequency * ratio;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(level * amplitude, when + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + decay);
    oscillator.connect(gain);
    gain.connect(master!);
    gain.connect(reverbSend!);
    oscillator.start(when);
    oscillator.stop(when + decay + 0.1);
  }
}

// D Dorian across two octaves: D E F G A B C.
const DORIAN = [146.83, 164.81, 174.61, 196, 220, 246.94, 261.63, 293.66, 329.63, 349.23, 392, 440, 493.88, 523.25, 587.33];

export function playCue(cue: Cue) {
  if (!soundOn) return;
  const ctx = graph();
  if (!ctx) return;
  const now = ctx.currentTime + 0.01;
  switch (cue) {
    case "hover": return pluck(ctx, DORIAN[11], now, 0.08, 0.8, 0.4);
    case "tap": return pluck(ctx, DORIAN[7 + Math.floor(Math.random() * 3)], now, 0.22, 1.4, 0.5, (Math.random() - 0.5) * 0.4);
    case "open": pluck(ctx, DORIAN[4], now, 0.24, 1.8, 0.5, -0.2); return pluck(ctx, DORIAN[7], now + 0.07, 0.22, 1.8, 0.5, 0.2);
    case "morph": [0, 2, 4].forEach((step, index) => pluck(ctx, DORIAN[step], now + index * 0.05, 0.12, 1.4, 0.4)); return;
    case "send": [0, 2, 4, 7, 9].forEach((step, index) => pluck(ctx, DORIAN[step + 3], now + index * 0.07, 0.24, 2.2, 0.55, -0.4 + index * 0.2)); return;
    case "success":
      [7, 9, 11, 14].forEach((step, index) => pluck(ctx, DORIAN[step], now + index * 0.09, 0.22, 2.6, 0.6, -0.3 + index * 0.2));
      return bell(ctx, 587.33, now + 0.4, 0.22);
    case "bell": return bell(ctx, 392, now, 0.3);
    case "chime": pluck(ctx, DORIAN[7], now, 0.25, 2, 0.55); return pluck(ctx, DORIAN[11], now + 0.12, 0.2, 2, 0.55);
    case "error": pluck(ctx, 110, now, 0.35, 1.2, 0.3); return pluck(ctx, 116.54, now + 0.11, 0.3, 1.2, 0.3);
  }
}

// ---- Elysian ambience ----

let musicNodes: { stop(): void } | undefined;

function startMusic() {
  if (!musicOn || musicNodes) return;
  const ctx = graph();
  if (!ctx) return;
  const bus = ctx.createGain();
  bus.gain.setValueAtTime(0.0001, ctx.currentTime);
  bus.gain.exponentialRampToValueAtTime(0.09, ctx.currentTime + 3);
  const warm = ctx.createBiquadFilter();
  warm.type = "lowpass";
  warm.frequency.value = 700;
  bus.connect(warm).connect(master!);
  const drones = [73.42, 110, 146.83].map((frequency, index) => {
    const oscillator = ctx.createOscillator();
    oscillator.type = index === 2 ? "sine" : "triangle";
    oscillator.frequency.value = frequency;
    oscillator.detune.value = (index - 1) * 4;
    const gain = ctx.createGain();
    gain.gain.value = index === 2 ? 0.25 : 0.5;
    // A slow swell, like breath.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.05 + index * 0.02;
    const depth = ctx.createGain();
    depth.gain.value = 0.18;
    lfo.connect(depth).connect(gain.gain);
    oscillator.connect(gain).connect(bus);
    oscillator.start();
    lfo.start();
    return [oscillator, lfo];
  }).flat();
  let timer = 0;
  const phrase = () => {
    if (!musicOn || !context) return;
    const start = context.currentTime + 0.05;
    const notes = 2 + Math.floor(Math.random() * 4);
    let step = 4 + Math.floor(Math.random() * 5);
    for (let index = 0; index < notes; index++) {
      step = Math.max(0, Math.min(DORIAN.length - 1, step + [-2, -1, 1, 2][Math.floor(Math.random() * 4)]));
      pluck(context, DORIAN[step], start + index * (0.32 + Math.random() * 0.25), 0.1, 2.6, 0.45, (Math.random() - 0.5) * 0.8);
    }
    timer = window.setTimeout(phrase, 3800 + Math.random() * 5200);
  };
  timer = window.setTimeout(phrase, 1500);
  musicNodes = {
    stop() {
      window.clearTimeout(timer);
      const end = ctx.currentTime + 1.5;
      bus.gain.cancelScheduledValues(ctx.currentTime);
      bus.gain.setValueAtTime(bus.gain.value, ctx.currentTime);
      bus.gain.exponentialRampToValueAtTime(0.0001, end);
      drones.forEach((node) => node.stop(end + 0.1));
    },
  };
}

function stopMusic() {
  musicNodes?.stop();
  musicNodes = undefined;
}

/** Reads a sentence aloud when the voice is on; a newer sentence replaces one still being read. */
export function speak(text: string) {
  if (!voiceOn || !voiceAvailable()) return;
  const synth = window.speechSynthesis;
  synth.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  const voices = synth.getVoices();
  const english = voices.find((voice) => /en(-|_)(US|GB)/i.test(voice.lang) && /natural|neural|premium|samantha|daniel|google/i.test(voice.name)) ?? voices.find((voice) => voice.lang.startsWith("en"));
  if (english) utterance.voice = english;
  utterance.rate = 0.98;
  utterance.pitch = 0.95;
  utterance.volume = 0.9;
  synth.speak(utterance);
}

/** The first interaction unlocks audio (and the ambience, if chosen); buttons and links then pluck softly. */
export function installSoundCues() {
  if (!browser) return;
  const unlock = () => {
    unlocked = true;
    graph();
    if (musicOn) startMusic();
  };
  window.addEventListener("pointerdown", unlock, { once: true, capture: true });
  window.addEventListener("keydown", unlock, { once: true, capture: true });
  document.addEventListener("click", (event) => {
    const target = (event.target as Element | null)?.closest?.("button, a, [role='tab'], [role='radio']");
    if (!target || (target as HTMLButtonElement).disabled || target.closest(".elysian-hero")) return;
    playCue(target.matches("a") ? "open" : "tap");
  }, { capture: true });
  // A soft string under the pointer on primary actions only, so moving across the page stays quiet.
  let lastHover = 0;
  document.addEventListener("pointerover", (event) => {
    const target = (event.target as Element | null)?.closest?.(".home-open, .wallet-button, .elysium-panel button.primary, .topbar-open");
    if (!target || performance.now() - lastHover < 250) return;
    lastHover = performance.now();
    playCue("hover");
  });
  document.addEventListener("visibilitychange", () => {
    if (!context) return;
    if (document.hidden) void context.suspend();
    else void context.resume();
  });
}
