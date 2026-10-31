/**
 * ElysaPay's sound: short cues synthesised with the Web Audio API (no audio files, nothing downloaded) and an optional
 * voice that reads a payment's review aloud with the browser's own speech synthesis.
 *
 * - Cues are soft, pitched in a pentatonic scale so any two that overlap still sound together, and never louder than a
 *   notification. They play only after the person has interacted with the page (browsers require it anyway).
 * - Both are a per-viewer choice kept in localStorage: cues are on by default, the voice is off by default.
 * - Nothing depends on sound: every cue accompanies text that already says the same thing.
 */
export type Cue = "tap" | "hover" | "send" | "success" | "error" | "morph" | "open" | "chime";

const SOUND_KEY = "elysapay.sound";
const VOICE_KEY = "elysapay.voice";
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

let soundOn = typeof window === "undefined" ? false : read(SOUND_KEY, true);
let voiceOn = typeof window === "undefined" ? false : read(VOICE_KEY, false);
let context: AudioContext | undefined;
let master: GainNode | undefined;
let unlocked = false;

export const soundEnabled = () => soundOn;
export const voiceEnabled = () => voiceOn;
export const voiceAvailable = () => typeof window !== "undefined" && "speechSynthesis" in window;

export function setSound(on: boolean) {
  soundOn = on;
  write(SOUND_KEY, on);
  if (on) playCue("chime");
  listeners.forEach((listener) => listener());
}

export function setVoice(on: boolean) {
  voiceOn = on;
  write(VOICE_KEY, on);
  if (!on && voiceAvailable()) window.speechSynthesis.cancel();
  if (on) speak("Voice on. ElysaPay will read each review aloud.");
  listeners.forEach((listener) => listener());
}

export function onSoundChange(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

function audio() {
  if (!soundOn || !unlocked || typeof window === "undefined") return undefined;
  const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Context) return undefined;
  if (!context) {
    context = new Context();
    master = context.createGain();
    master.gain.value = 0.16;
    // A gentle low-pass keeps every cue round, never sharp.
    const filter = context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 4200;
    master.connect(filter).connect(context.destination);
  }
  if (context.state === "suspended") void context.resume();
  return context;
}

/** One soft voice: a sine with a quick attack and an exponential tail, plus a quiet octave shimmer. */
function tone(ctx: AudioContext, frequency: number, start: number, length: number, level = 1, type: OscillatorType = "sine") {
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(level, start + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
  gain.connect(master!);
  const oscillator = ctx.createOscillator();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, start);
  oscillator.connect(gain);
  oscillator.start(start);
  oscillator.stop(start + length + 0.05);
  if (type === "sine") {
    const shimmer = ctx.createOscillator();
    const shimmerGain = ctx.createGain();
    shimmerGain.gain.value = 0.18;
    shimmer.frequency.setValueAtTime(frequency * 2.01, start);
    shimmer.connect(shimmerGain).connect(gain);
    shimmer.start(start);
    shimmer.stop(start + length + 0.05);
  }
}

// A major pentatonic around A4: every pair is consonant.
const SCALE = [440, 493.88, 554.37, 659.25, 739.99, 880, 987.77, 1108.73];

export function playCue(cue: Cue) {
  const ctx = audio();
  if (!ctx) return;
  const now = ctx.currentTime + 0.005;
  switch (cue) {
    case "hover": return tone(ctx, SCALE[5], now, 0.06, 0.12);
    case "tap": return tone(ctx, SCALE[3], now, 0.09, 0.35);
    case "open": tone(ctx, SCALE[2], now, 0.12, 0.3); return tone(ctx, SCALE[4], now + 0.06, 0.16, 0.3);
    case "morph": [0, 2, 4].forEach((step, index) => tone(ctx, SCALE[step] / 2, now + index * 0.045, 0.22, 0.18)); return;
    case "send": [1, 3, 5, 7].forEach((step, index) => tone(ctx, SCALE[step], now + index * 0.05, 0.18, 0.32)); return;
    case "success": [3, 5, 7].forEach((step, index) => tone(ctx, SCALE[step], now + index * 0.08, 0.5, 0.4)); return;
    case "chime": tone(ctx, SCALE[5], now, 0.6, 0.3); return tone(ctx, SCALE[7], now + 0.1, 0.7, 0.22);
    case "error": tone(ctx, 220, now, 0.18, 0.35, "triangle"); return tone(ctx, 207.65, now + 0.12, 0.26, 0.3, "triangle");
  }
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
  utterance.rate = 1.02;
  utterance.pitch = 1;
  utterance.volume = 0.9;
  synth.speak(utterance);
}

/** The first interaction unlocks audio; buttons and links then tap softly. */
export function installSoundCues() {
  if (typeof window === "undefined") return;
  const unlock = () => {
    unlocked = true;
    audio();
  };
  window.addEventListener("pointerdown", unlock, { once: true, capture: true });
  window.addEventListener("keydown", unlock, { once: true, capture: true });
  document.addEventListener("click", (event) => {
    const target = (event.target as Element | null)?.closest?.("button, a, [role='tab'], [role='radio']");
    if (!target || (target as HTMLButtonElement).disabled) return;
    playCue(target.matches("a") ? "open" : "tap");
  }, { capture: true });
}
