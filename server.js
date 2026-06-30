/**
 * Server — mints ephemeral auth tokens for the Gemini Live API.
 *
 * The browser calls POST /api/token, gets a single-use token with the model,
 * system prompt, and tool declarations locked in, then connects directly to
 * the Gemini Live WebSocket. The server never touches audio.
 */
import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI, Modality } from '@google/genai';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const LIVE_MODEL = 'gemini-3.1-flash-live-preview';

if (!GEMINI_API_KEY) {
  console.error('\n❌  GEMINI_API_KEY is not set. Copy .env.example to .env and add your key.\n');
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── System prompt (locked into the token) ────────────────────────
const SYSTEM_PROMPT = `You are Avery, a warm and knowledgeable travel-planning voice assistant. You help with flights, hotels and other accommodation, destinations, itineraries, packing, local transport, visas and entry-requirement basics, trip budgeting, and weather as it relates to travel planning.

VOICE & TONE: Conversational and natural, like a sharp, friendly travel agent who's genuinely interested in someone's trip — not a script reader. Keep responses short and spoken-sounding; this is a voice conversation, not a written document, so avoid long lists or formal structure.

OPENING: When the conversation starts, or on any greeting like "hi" or "hello," greet the person warmly in one or two sentences and ask what trip they're working on or how you can help (flights, a destination, an itinerary, etc.). Vary the phrasing naturally rather than reciting it identically every time.

SCOPE: You only help with travel topics. If a request is unrelated — code, homework, recipes, general trivia, therapy, anything else — respond the way a friendly human travel agent would if a customer asked them something completely outside their job: light, warm, brief, and redirect back to travel with a genuine follow-up question. Vary your phrasing each time; never repeat an identical refusal twice in one conversation, and never explain what you are ("I'm an AI assistant...") — just stay yourself.

LANGUAGE: Respond in whatever language the person speaks to you in, and switch naturally if they switch mid-conversation.

If a flight-search tool is available, use it for concrete flight options rather than inventing specific flights, prices, or times yourself. Likewise, if a hotel-search tool is available, use it for concrete hotels near a destination instead of inventing them. Whenever someone asks about a destination or a trip, it's helpful to look up both flights and nearby hotels so they can see real options.`;

// ── Tool declarations ────────────────────────────────────────────
const searchFlightsDeclaration = {
  name: 'search_flights',
  description: 'Search for available flights between two cities on a given date. Returns a short list of mock flight options (airline, times, stops, price). Use this whenever the user asks for concrete flight options instead of inventing flights yourself.',
  parameters: {
    type: 'OBJECT',
    properties: {
      origin:      { type: 'STRING', description: "Departure city or airport (e.g. 'London' or 'LHR')." },
      destination: { type: 'STRING', description: "Arrival city or airport (e.g. 'Tokyo' or 'HND')." },
      date:        { type: 'STRING', description: 'Departure date in natural language or YYYY-MM-DD. Optional.' },
    },
    required: ['origin', 'destination'],
  },
};

const searchHotelsDeclaration = {
  name: 'search_hotels',
  description: 'Search for hotels near a destination city or landmark. Returns a short list of mock hotels (name, area, rating, nightly price, distance). Use this whenever the user asks about places to stay, or when discussing a destination.',
  parameters: {
    type: 'OBJECT',
    properties: {
      destination: { type: 'STRING', description: "Destination city, area, or landmark (e.g. 'Tokyo' or 'Lisbon old town')." },
    },
    required: ['destination'],
  },
};

// ── Build locked config with optional locale ─────────────────────
function buildLockedConfig(pref) {
  let systemInstruction = SYSTEM_PROMPT;
  if (pref) {
    systemInstruction += `

⚠️ MANDATORY LANGUAGE AND CURRENCY CONSTRAINTS:
1. Speak in ${pref.language}. If they speak in a different language, switch to it, but otherwise respond in ${pref.language}.
2. ALL prices, fares, hotel rates, and budgets MUST be converted and quoted in ${pref.currency} (Rupees / ₹ for INR, or Euros for EUR, etc.).
3. DO NOT output the dollar sign ($) or quote any prices in USD (US Dollars) under any circumstances.
4. The flight/hotel search tools return prices in US dollars. You MUST convert them to ${pref.currency} before speaking or writing them, by multiplying the USD amount by approximately ${pref.rate}, and rounding to a natural-sounding figure. (e.g. Convert $100 USD to ${100 * pref.rate} ${pref.currency}). Always state the currency name explicitly.`;
  }
  return {
    responseModalities: [Modality.AUDIO],
    systemInstruction,
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    tools: [{ functionDeclarations: [searchFlightsDeclaration, searchHotelsDeclaration] }],
  };
}

// ── Token endpoint ───────────────────────────────────────────────
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY, httpOptions: { apiVersion: 'v1alpha' } });

app.post('/api/token', async (req, res) => {
  let pref;
  try {
    const body = req.body;
    if (typeof body?.language === 'string' && typeof body?.currency === 'string' && typeof body?.rate === 'number') {
      pref = { language: body.language, currency: body.currency, rate: body.rate };
    }
  } catch { /* no body */ }

  try {
    const token = await ai.authTokens.create({
      config: {
        uses: 1,
        expireTime: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        liveConnectConstraints: {
          model: LIVE_MODEL,
          config: buildLockedConfig(pref),
        },
        httpOptions: { apiVersion: 'v1alpha' },
      },
    });
    res.json({ token: token.name, model: LIVE_MODEL });
  } catch (err) {
    console.error('Failed to mint ephemeral token:', err);
    res.status(502).json({ error: 'Could not create a voice session. Please try again.' });
  }
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', model: LIVE_MODEL }));

app.listen(PORT, () => {
  console.log(`\n✈  Avery is ready at http://localhost:${PORT}`);
  console.log(`   Model: ${LIVE_MODEL}\n`);
});
