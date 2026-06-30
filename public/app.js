/**
 * Avery — Voice Travel Agent (Single-Page App)
 *
 * This is the complete client-side logic, ported from the React/TanStack
 * reference app into a vanilla JS single-page app. It connects directly to
 * the Gemini Live WebSocket using an ephemeral token from the server.
 *
 * Architecture:
 *   Mic → 16kHz PCM → Browser → WebSocket → Gemini Live API
 *   Browser ← WebSocket ← Gemini Live API (24kHz PCM)
 *   Browser ↔ POST /api/token (server holds API key)
 */

import { GoogleGenAI, Modality } from '@google/genai';

// ══════════════════════════════════════════════════════════════════
//  i18n — Languages + Currency
// ══════════════════════════════════════════════════════════════════
const LANGUAGES = [
  { code: 'English',    label: 'English',    flag: '🇺🇸', currency: 'USD', locale: 'en-US', rate: 1 },
  { code: 'Español',    label: 'Español',    flag: '🇪🇸', currency: 'EUR', locale: 'es-ES', rate: 0.92 },
  { code: 'Français',   label: 'Français',   flag: '🇫🇷', currency: 'EUR', locale: 'fr-FR', rate: 0.92 },
  { code: 'Deutsch',    label: 'Deutsch',    flag: '🇩🇪', currency: 'EUR', locale: 'de-DE', rate: 0.92 },
  { code: 'हिन्दी',      label: 'हिन्दी',      flag: '🇮🇳', currency: 'INR', locale: 'hi-IN', rate: 83 },
  { code: '日本語',      label: '日本語',      flag: '🇯🇵', currency: 'JPY', locale: 'ja-JP', rate: 157 },
  { code: 'Português',  label: 'Português',  flag: '🇧🇷', currency: 'BRL', locale: 'pt-BR', rate: 5.1 },
];

const DEFAULT_LANG = LANGUAGES[0];

function languageByCode(code) {
  return LANGUAGES.find(l => l.code === code) || DEFAULT_LANG;
}

function formatPrice(usd, lang) {
  const value = usd * lang.rate;
  return new Intl.NumberFormat(lang.locale, {
    style: 'currency',
    currency: lang.currency,
    maximumFractionDigits: 0,
  }).format(value);
}

const STRINGS = {
  English:    { flights:'Flights', hotels:'Hotels nearby', perNight:'/ night', nonstop:'Nonstop', stop:'stop', stops:'stops', viewDetails:'View details', departs:'Departs', arrives:'Arrives', duration:'Duration', rating:'Rating' },
  Español:    { flights:'Vuelos', hotels:'Hoteles cercanos', perNight:'/ noche', nonstop:'Directo', stop:'escala', stops:'escalas', viewDetails:'Ver detalles', departs:'Sale', arrives:'Llega', duration:'Duración', rating:'Valoración' },
  Français:   { flights:'Vols', hotels:'Hôtels à proximité', perNight:'/ nuit', nonstop:'Direct', stop:'escale', stops:'escales', viewDetails:'Voir les détails', departs:'Départ', arrives:'Arrivée', duration:'Durée', rating:'Note' },
  Deutsch:    { flights:'Flüge', hotels:'Hotels in der Nähe', perNight:'/ Nacht', nonstop:'Nonstop', stop:'Stopp', stops:'Stopps', viewDetails:'Details ansehen', departs:'Abflug', arrives:'Ankunft', duration:'Dauer', rating:'Bewertung' },
  'हिन्दी':     { flights:'उड़ानें', hotels:'पास के होटल', perNight:'/ रात', nonstop:'नॉनस्टॉप', stop:'ठहराव', stops:'ठहराव', viewDetails:'विवरण देखें', departs:'प्रस्थान', arrives:'आगमन', duration:'अवधि', rating:'रेटिंग' },
  '日本語':     { flights:'フライト', hotels:'近くのホテル', perNight:'/ 泊', nonstop:'直行', stop:'経由', stops:'経由', viewDetails:'詳細を見る', departs:'出発', arrives:'到着', duration:'所要時間', rating:'評価' },
  Português:  { flights:'Voos', hotels:'Hotéis próximos', perNight:'/ noite', nonstop:'Direto', stop:'parada', stops:'paradas', viewDetails:'Ver detalhes', departs:'Partida', arrives:'Chegada', duration:'Duração', rating:'Avaliação' },
};

function t(lang, key) {
  return STRINGS[lang.code]?.[key] ?? STRINGS.English[key] ?? key;
}

// ══════════════════════════════════════════════════════════════════
//  Mock Flight + Hotel Search (deterministic, client-side)
// ══════════════════════════════════════════════════════════════════
function hash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function fmtTime(minutesFromMidnight) {
  const h = Math.floor(minutesFromMidnight / 60) % 24;
  const m = minutesFromMidnight % 60;
  const ampm = h < 12 ? 'AM' : 'PM';
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}:${m.toString().padStart(2, '0')} ${ampm}`;
}

const AIRLINES = [
  { name: 'Skyhaven Air', code: 'SH' },
  { name: 'Meridian Airways', code: 'MD' },
  { name: 'Cirrus Atlantic', code: 'CA' },
  { name: 'Northwind Express', code: 'NW' },
];

function searchFlights(origin, destination, date) {
  const seed = hash(`${origin}|${destination}|${date || ''}`);
  const options = [];
  for (let i = 0; i < 3; i++) {
    const a = AIRLINES[(seed + i) % AIRLINES.length];
    const depMin = 360 + ((seed >> (i + 1)) % 12) * 60;
    const duration = 2 + ((seed >> i) % 11);
    const stops = i === 0 ? 0 : (seed >> (i * 2)) % 2;
    const basePrice = 180 + ((seed >> (i + 2)) % 9) * 65 + stops * 40;
    options.push({
      airline: a.name,
      flightNumber: `${a.code}${100 + ((seed >> i) % 800)}`,
      departure: fmtTime(depMin),
      arrival: fmtTime(depMin + duration * 60 + stops * 75),
      durationHours: duration,
      stops,
      priceUsd: basePrice,
    });
  }
  options.sort((x, y) => x.priceUsd - y.priceUsd);
  return { origin, destination, date: date || 'flexible', options };
}

const HOTEL_NAMES = [
  { name: 'The Marlowe', area: 'Old Town' },
  { name: 'Azure Bay Hotel', area: 'Waterfront' },
  { name: 'Casa Verde Boutique', area: 'Arts District' },
  { name: 'Grand Meridian', area: 'City Centre' },
  { name: 'Lumen Suites', area: 'Riverside' },
];
const PERKS = ['Free Wi-Fi', 'Breakfast included', 'Pool', 'Gym', 'Airport shuttle', 'Spa'];

function searchHotels(destination) {
  const seed = hash(destination.toLowerCase());
  const options = [];
  for (let i = 0; i < 3; i++) {
    const n = HOTEL_NAMES[(seed + i) % HOTEL_NAMES.length];
    const rating = 3.8 + ((seed >> i) % 13) / 10;
    const reviews = 120 + ((seed >> (i + 1)) % 40) * 37;
    const price = 75 + ((seed >> (i + 2)) % 9) * 38;
    const distance = 0.4 + ((seed >> i) % 35) / 10;
    const perks = [...new Set([PERKS[(seed + i) % PERKS.length], PERKS[(seed + i + 2) % PERKS.length]])];
    options.push({
      name: n.name, area: n.area,
      rating: Math.min(5, Math.round(rating * 10) / 10),
      reviews, pricePerNightUsd: price,
      distanceKm: Math.round(distance * 10) / 10,
      perks,
    });
  }
  options.sort((a, b) => a.pricePerNightUsd - b.pricePerNightUsd);
  return { destination, options };
}

// ══════════════════════════════════════════════════════════════════
//  AudioRecorder — Mic → 16kHz PCM → base64
// ══════════════════════════════════════════════════════════════════
function floatTo16BitPCM(input) {
  const buffer = new ArrayBuffer(input.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToInt16(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

class AudioRecorder {
  constructor(onChunk) {
    this.onChunk = onChunk;
    this.ctx = null;
    this.stream = null;
    this.source = null;
    this.processor = null;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.ctx = new AudioContext({ sampleRate: 16000 });
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.processor = this.ctx.createScriptProcessor(2048, 1, 1);
    this.processor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      const pcm = floatTo16BitPCM(input);
      this.onChunk(arrayBufferToBase64(pcm));
    };
    this.source.connect(this.processor);
    this.processor.connect(this.ctx.destination);
  }

  stop() {
    this.processor?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach(t => t.stop());
    this.ctx?.close();
    this.processor = null;
    this.source = null;
    this.stream = null;
    this.ctx = null;
  }
}

// ══════════════════════════════════════════════════════════════════
//  AudioPlayer — 24kHz PCM base64 → gapless playback + barge-in
// ══════════════════════════════════════════════════════════════════
class AudioPlayer {
  constructor(onSpeakingChange) {
    this.onSpeakingChange = onSpeakingChange;
    this.ctx = null;
    this.nextStartTime = 0;
    this.sources = new Set();
  }

  ensureCtx() {
    if (!this.ctx || this.ctx.state === 'closed') {
      this.ctx = new AudioContext({ sampleRate: 24000 });
      this.nextStartTime = 0;
    }
    return this.ctx;
  }

  enqueue(base64) {
    const ctx = this.ensureCtx();
    if (ctx.state === 'suspended') ctx.resume();

    const int16 = base64ToInt16(base64);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 0x8000;

    const buffer = ctx.createBuffer(1, float32.length, 24000);
    buffer.copyToChannel(float32, 0);

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);

    const now = ctx.currentTime;
    const startAt = Math.max(now, this.nextStartTime);
    src.start(startAt);
    this.nextStartTime = startAt + buffer.duration;

    if (this.sources.size === 0) this.onSpeakingChange?.(true);
    this.sources.add(src);
    src.onended = () => {
      this.sources.delete(src);
      if (this.sources.size === 0) this.onSpeakingChange?.(false);
    };
  }

  interrupt() {
    this.sources.forEach(s => { try { s.stop(); } catch {} });
    this.sources.clear();
    this.nextStartTime = this.ctx ? this.ctx.currentTime : 0;
    this.onSpeakingChange?.(false);
  }

  close() {
    this.interrupt();
    this.ctx?.close();
    this.ctx = null;
  }
}

// ══════════════════════════════════════════════════════════════════
//  DOM References
// ══════════════════════════════════════════════════════════════════
const $ = (id) => document.getElementById(id);

const langSelect   = $('langSelect');
const langFlag     = $('langFlag');
const btnMic       = $('btnMic');
const iconMic      = $('iconMic');
const iconMicOff   = $('iconMicOff');
const iconSpinner  = $('iconSpinner');
const orbRing1     = $('orbRing1');
const orbRing2     = $('orbRing2');
const statusLine   = $('statusLine');
const btnEnd       = $('btnEnd');
const suggestions  = $('suggestions');
const resultsSection   = $('resultsSection');
const flightsCard  = $('flightsCard');
const hotelsCard   = $('hotelsCard');
const transcriptSection = $('transcriptSection');
const transcriptList    = $('transcriptList');
const activityList      = $('activityList');

// ══════════════════════════════════════════════════════════════════
//  State
// ══════════════════════════════════════════════════════════════════
let status = 'idle';        // idle | connecting | live | error
let muted = false;
let agentSpeaking = false;
let errorMessage = null;
let session = null;
let recorder = null;
let player = null;
let transcript = [];        // { id, role, text, ts }
let liveUser = '';
let liveAgent = '';
let userBuf = '';
let agentBuf = '';
let logs = [];
let flightsData = null;
let hotelsData = null;
let userTurnAt = null;
let awaitingFirstAudio = false;
let idCounter = 0;
let currentLang = DEFAULT_LANG;

// Restore saved language
const savedLang = localStorage.getItem('avery-lang');
if (savedLang) {
  currentLang = languageByCode(savedLang);
  langSelect.value = currentLang.code;
  langFlag.textContent = currentLang.flag;
}

langSelect.addEventListener('change', (e) => {
  currentLang = languageByCode(e.target.value);
  langFlag.textContent = currentLang.flag;
  localStorage.setItem('avery-lang', currentLang.code);
});

// ══════════════════════════════════════════════════════════════════
//  Logging
// ══════════════════════════════════════════════════════════════════
function log(type, detail, latencyMs) {
  const evt = { ts: Date.now(), type, detail, latencyMs };
  console.log(`[voice-agent] ${type}: ${detail}${latencyMs != null ? ` (${latencyMs}ms)` : ''}`);
  logs.push(evt);
  if (logs.length > 200) logs = logs.slice(-200);
  renderActivity();
}

// ══════════════════════════════════════════════════════════════════
//  Rendering
// ══════════════════════════════════════════════════════════════════
function renderUI() {
  const isLive = status === 'live';
  const isConnecting = status === 'connecting';
  const orbActive = isLive && (agentSpeaking || !muted);

  // Orb rings
  orbRing1.classList.toggle('hidden', !orbActive);
  orbRing2.classList.toggle('hidden', !orbActive);

  // Orb button state
  btnMic.disabled = isConnecting;
  btnMic.className = 'orb-btn';
  if (isLive && muted)     btnMic.classList.add('orb-btn--muted');
  else if (isLive)         btnMic.classList.add('orb-btn--live');
  else                     btnMic.classList.add('orb-btn--idle');

  // Icons
  iconMic.classList.toggle('hidden', isConnecting || (isLive && muted));
  iconMicOff.classList.toggle('hidden', !(isLive && muted));
  iconSpinner.classList.toggle('hidden', !isConnecting);

  // Status line
  if (status === 'idle')                                        statusLine.innerHTML = 'Tap to connect';
  else if (isConnecting)                                        statusLine.innerHTML = 'Connecting…';
  else if (isLive && agentSpeaking)                             statusLine.innerHTML = '<span class="status-primary">Avery is speaking…</span>';
  else if (isLive && !agentSpeaking && !muted)                  statusLine.innerHTML = '<span class="status-accent">Listening… go ahead</span>';
  else if (isLive && !agentSpeaking && muted)                   statusLine.innerHTML = 'Muted — tap the mic to talk';
  else if (status === 'error')                                  statusLine.innerHTML = `<span class="status-error">${errorMessage || 'Error'}</span>`;

  // End button
  btnEnd.classList.toggle('hidden', !isLive);

  // Suggestions
  suggestions.classList.toggle('hidden', status !== 'idle');

  // Results
  const hasResults = flightsData || hotelsData;
  resultsSection.classList.toggle('hidden', !hasResults);
  flightsCard.classList.toggle('hidden', !flightsData);
  hotelsCard.classList.toggle('hidden', !hotelsData);

  // Transcript section
  const hasTranscript = transcript.length > 0 || isLive;
  transcriptSection.classList.toggle('hidden', !hasTranscript);
}

function renderTranscript() {
  let html = '';
  if (transcript.length === 0 && !liveUser && !liveAgent) {
    html = '<p class="placeholder-text">Your conversation will appear here as you talk.</p>';
  } else {
    for (const tr of transcript) {
      html += makeBubbleHTML(tr.role, tr.text, false);
    }
    if (liveUser) html += makeBubbleHTML('user', liveUser, true);
    if (liveAgent) html += makeBubbleHTML('agent', liveAgent, true);
  }
  transcriptList.innerHTML = html;
  transcriptList.scrollTop = transcriptList.scrollHeight;
}

function makeBubbleHTML(role, text, partial) {
  const isUser = role === 'user';
  return `<div class="bubble-row ${isUser ? 'bubble-row--user' : 'bubble-row--agent'}">
    <div class="bubble ${isUser ? 'bubble--user' : 'bubble--agent'} ${partial ? 'bubble--partial' : ''}">
      ${!isUser ? '<span class="bubble-label">Avery</span>' : ''}${escapeHtml(text)}
    </div>
  </div>`;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderActivity() {
  if (logs.length === 0) {
    activityList.innerHTML = '<p class="placeholder-text">Turn events, tool calls, interruptions and latency show up here.</p>';
    return;
  }
  let html = '';
  for (let i = logs.length - 1; i >= 0; i--) {
    const l = logs[i];
    const ts = new Date(l.ts).toLocaleTimeString([], { hour12: false, minute: '2-digit', second: '2-digit' });
    const cls = `log-detail--${l.type}`;
    html += `<div class="log-entry"><span class="log-ts">${ts}</span><span class="${cls}">${escapeHtml(l.detail)}${l.latencyMs != null ? ` <span class="log-latency">· ${l.latencyMs}ms</span>` : ''}</span></div>`;
  }
  activityList.innerHTML = html;
}

function renderFlights(result) {
  const lang = currentLang;
  let html = `<h2 class="result-card-heading">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/></svg>
    ${t(lang, 'flights')}
  </h2>
  <p class="result-card-subheading">
    <span class="font-medium">${escapeHtml(result.origin)}</span>
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
    <span class="font-medium">${escapeHtml(result.destination)}</span>
    <span>· ${escapeHtml(result.date)}</span>
  </p>
  <div class="result-items">`;

  for (const opt of result.options) {
    const stopsLabel = opt.stops === 0 ? t(lang, 'nonstop') : `${opt.stops} ${opt.stops === 1 ? t(lang, 'stop') : t(lang, 'stops')}`;
    html += `<button class="item-card" onclick="this.querySelector('.item-details')?.classList.toggle('hidden')">
      <div class="item-row">
        <div><p class="item-name">${escapeHtml(opt.airline)}</p><p class="item-meta">${opt.flightNumber} · ${stopsLabel}</p></div>
        <div><p class="item-price">${formatPrice(opt.priceUsd, lang)}</p><p class="item-price-sub">${t(lang, 'viewDetails')}</p></div>
      </div>
      <div class="item-details hidden">
        <div class="detail-item"><span class="detail-label"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>${t(lang, 'departs')}</span><span class="detail-value">${opt.departure}</span></div>
        <div class="detail-item"><span class="detail-label"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>${t(lang, 'arrives')}</span><span class="detail-value">${opt.arrival}</span></div>
        <div class="detail-item"><span class="detail-label"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>${t(lang, 'duration')}</span><span class="detail-value">${opt.durationHours}h</span></div>
      </div>
    </button>`;
  }
  html += '</div>';
  flightsCard.innerHTML = html;
}

function renderHotels(result) {
  const lang = currentLang;
  let html = `<h2 class="result-card-heading">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2Z"/><path d="m9 16 .348-.24c1.465-1.013 3.84-1.013 5.304 0L15 16"/><path d="M8 7h.01"/><path d="M16 7h.01"/></svg>
    ${t(lang, 'hotels')}
  </h2>
  <p class="result-card-subheading">
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>
    <span class="font-medium">${escapeHtml(result.destination)}</span>
  </p>
  <div class="result-items">`;

  for (const opt of result.options) {
    html += `<button class="item-card" onclick="this.querySelector('.item-details-2col')?.classList.toggle('hidden')">
      <div class="item-row">
        <div><p class="item-name">${escapeHtml(opt.name)}</p><p class="item-meta"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>${opt.rating.toFixed(1)} · ${escapeHtml(opt.area)}</p></div>
        <div><p class="item-price">${formatPrice(opt.pricePerNightUsd, lang)}</p><p class="item-price-sub">${t(lang, 'perNight')}</p></div>
      </div>
      <div class="item-details-2col hidden">
        <div class="detail-grid-2">
          <div class="detail-item"><span class="detail-label"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>Distance</span><span class="detail-value">${opt.distanceKm} km</span></div>
          <div class="detail-item"><span class="detail-label"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>${t(lang, 'rating')}</span><span class="detail-value">${opt.rating.toFixed(1)} (${opt.reviews})</span></div>
        </div>
        <div class="perks-wrap">${opt.perks.map(p => `<span class="perk">${escapeHtml(p)}</span>`).join('')}</div>
      </div>
    </button>`;
  }
  html += '</div>';
  hotelsCard.innerHTML = html;
}

// ══════════════════════════════════════════════════════════════════
//  Voice Agent — Connect / Disconnect / Message Handling
// ══════════════════════════════════════════════════════════════════
function commitTurns() {
  const user = userBuf.trim();
  const agent = agentBuf.trim();
  if (user) transcript.push({ id: `${Date.now()}-${idCounter++}`, role: 'user', text: user, ts: Date.now() });
  if (agent) transcript.push({ id: `${Date.now()}-${idCounter++}`, role: 'agent', text: agent, ts: Date.now() });
  userBuf = '';
  agentBuf = '';
  liveUser = '';
  liveAgent = '';
  renderTranscript();
}

function handleMessage(message) {
  const content = message.serverContent;

  // Barge-in
  if (content?.interrupted) {
    player?.interrupt();
    log('interruption', 'User interrupted the agent (barge-in).');
  }

  // Streamed agent audio
  const audio = message.data;
  if (audio) {
    if (awaitingFirstAudio && userTurnAt != null) {
      const latency = Date.now() - userTurnAt;
      log('latency', 'Time to first agent audio', latency);
      awaitingFirstAudio = false;
    }
    player?.enqueue(audio);
  }

  // Transcriptions
  if (content?.inputTranscription?.text) {
    userBuf += content.inputTranscription.text;
    userTurnAt = Date.now();
    awaitingFirstAudio = true;
    liveUser = userBuf;
    renderTranscript();
  }
  if (content?.outputTranscription?.text) {
    agentBuf += content.outputTranscription.text;
    liveAgent = agentBuf;
    renderTranscript();
  }

  // Tool calls
  if (message.toolCall?.functionCalls?.length) {
    const functionResponses = message.toolCall.functionCalls.map(fc => {
      if (fc.name === 'search_flights') {
        const args = fc.args || {};
        const result = searchFlights(args.origin || '', args.destination || '', args.date);
        log('tool', `search_flights(${args.origin} → ${args.destination}) → ${result.options.length} options`);
        flightsData = result;
        renderFlights(result);
        renderUI();
        return { id: fc.id, name: fc.name, response: { result } };
      }
      if (fc.name === 'search_hotels') {
        const args = fc.args || {};
        const result = searchHotels(args.destination || '');
        log('tool', `search_hotels(${args.destination}) → ${result.options.length} options`);
        hotelsData = result;
        renderHotels(result);
        renderUI();
        return { id: fc.id, name: fc.name, response: { result } };
      }
      return { id: fc.id, name: fc.name, response: { error: 'Unknown tool' } };
    });
    session?.sendToolResponse({ functionResponses });
  }

  // Turn complete
  if (content?.turnComplete) {
    commitTurns();
    log('turn', 'Turn complete.');
  }
}

async function connect() {
  status = 'connecting';
  errorMessage = null;
  renderUI();

  try {
    // 1. Get token from server
    const res = await fetch('/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language: currentLang.code, currency: currentLang.currency, rate: currentLang.rate }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Could not start a voice session.');
    }
    const { token, model } = await res.json();

    // 2. Connect to Live API
    const ai = new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: 'v1alpha' } });

    player = new AudioPlayer((speaking) => {
      agentSpeaking = speaking;
      renderUI();
    });

    session = await ai.live.connect({
      model,
      config: { responseModalities: [Modality.AUDIO] },
      callbacks: {
        onopen: () => log('session', 'Live session open.'),
        onmessage: handleMessage,
        onerror: (e) => {
          log('error', e.message || 'WebSocket error');
          status = 'error';
          errorMessage = 'Connection error.';
          renderUI();
        },
        onclose: () => log('session', 'Live session closed.'),
      },
    });

    // 3. Start mic
    recorder = new AudioRecorder((base64) => {
      session?.sendRealtimeInput({
        audio: { data: base64, mimeType: 'audio/pcm;rate=16000' },
      });
    });
    await recorder.start();

    status = 'live';
    muted = false;
    renderUI();
    log('session', 'Connected. Say hi to Avery!');
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Something went wrong.';
    log('error', msg);
    disconnect();
    status = 'error';
    errorMessage = msg;
    renderUI();
  }
}

function disconnect() {
  recorder?.stop();
  recorder = null;
  player?.close();
  player = null;
  session?.close();
  session = null;
  userBuf = '';
  agentBuf = '';
  liveUser = '';
  liveAgent = '';
  status = 'idle';
  muted = false;
  agentSpeaking = false;
  renderUI();
  renderTranscript();
  log('session', 'Disconnected.');
}

async function toggleMute() {
  if (!muted) {
    // Mute
    recorder?.stop();
    recorder = null;
    muted = true;
    log('session', 'Microphone muted.');
  } else {
    // Unmute
    recorder = new AudioRecorder((base64) => {
      session?.sendRealtimeInput({
        audio: { data: base64, mimeType: 'audio/pcm;rate=16000' },
      });
    });
    try {
      await recorder.start();
      muted = false;
      log('session', 'Microphone live.');
    } catch {
      log('error', 'Could not access the microphone.');
    }
  }
  renderUI();
}

// ══════════════════════════════════════════════════════════════════
//  Event Listeners
// ══════════════════════════════════════════════════════════════════
btnMic.addEventListener('click', () => {
  if (status === 'idle' || status === 'error') {
    connect();
  } else if (status === 'live') {
    toggleMute();
  }
});

btnEnd.addEventListener('click', disconnect);

// Initial render
renderUI();
renderTranscript();
