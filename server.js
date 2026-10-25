const express = require("express");
const path = require("path");

const app = express();
app.use(express.json({ limit: "12mb" }));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

const KEY = process.env.GEMINI_API_KEY;
const MAX_IMAGES = Number(process.env.MAX_IMAGES || 2);
const HOURLY_LIMIT = Number(process.env.HOURLY_LIMIT || 10);
const BASE = "https://generativelanguage.googleapis.com/v1beta";

const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 3600000);
  if (list.length >= HOURLY_LIMIT) { hits.set(ip, list); return true; }
  list.push(now); hits.set(ip, list); return false;
}

// Finds current Gemini model names automatically
let cache = null;
async function models() {
  if (cache) return cache;
  const r = await fetch(BASE + "/models?pageSize=200", { headers: { "x-goog-api-key": KEY } });
  if (!r.ok) throw new Error("Models error " + r.status);
  const all = ((await r.json()).models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map((m) => m.name.replace("models/", ""));
  const ver = (n) => parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [0, 0])[1]);
  const pre = (n) => (/(preview|exp)/.test(n) ? 1 : 0);
  const best = (a) => a.sort((x, y) => ver(y) - ver(x) || pre(x) - pre(y))[0];
  const text = best(all.filter((n) => /flash/.test(n) && !/(image|tts|live|audio|embedding|lite)/.test(n)))
    || best(all.filter((n) => /flash/.test(n) && !/(image|tts|live|audio|embedding)/.test(n)));
  const image = best(all.filter((n) => /image/.test(n) && !/imagen/.test(n)));
  cache = { text: process.env.GEMINI_TEXT_MODEL || text, image: process.env.GEMINI_MODEL || image };
  console.log("Models:", cache);
  return cache;
}

async function gemini(model, body) {
  const r = await fetch(`${BASE}/models/${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": KEY },
    body: JSON.stringify(body),
  });
  if (!r.ok) { cache = null; throw new Error("Gemini " + model + " " + r.status + ": " + (await r.text()).slice(0, 300)); }
  return r.json();
}

async function plan({ image, mime, budget, currency, style }) {
  const m = await models();
  const prompt =
    `You are an expert interior, landscape and architectural designer. Study the attached photo of a space. ` +
    `Budget: ${budget} ${currency}. ${style ? "Preferred style: " + style + ". " : ""}` +
    `Return ONLY JSON: {"space":"short description of the space type, size, light and condition",` +
    `"concepts":[3 items, each {"name":"","style":"","summary":"one sentence","palette":["#hex","#hex","#hex","#hex"],` +
    `"changes":["4 specific changes"],"cost_low":number,"cost_high":number,"within_budget":true or false,` +
    `"image_prompt":"detailed instruction to redesign THIS exact space in this style, keep the structure and camera angle, photorealistic"}],` +
    `"best":index 0-2 of the concept that looks most beautiful within the budget}. ` +
    `Costs are realistic rough estimates in ${currency}. Keep at least the best concept within budget.`;
  const data = await gemini(m.text, {
    contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mime, data: image } }] }],
    generationConfig: { responseMimeType: "application/json" },
  });
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("")
    .replace(/```json|```/g, "").trim();
  return JSON.parse(text);
}

async function picture({ image, mime }, prompt) {
  const m = await models();
  const data = await gemini(m.image, {
    contents: [{ parts: [
      { text: "Edit this photo: " + prompt + " Keep the same layout, walls, windows and camera angle." },
      { inline_data: { mime_type: mime, data: image } },
    ] }],
    generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
  });
  const parts = data.candidates?.[0]?.content?.parts || [];
  const img = parts.map((p) => p.inlineData || p.inline_data).find(Boolean);
  if (!img) throw new Error("No image returned");
  return `data:${img.mimeType || img.mime_type};base64,${img.data}`;
}

app.post("/api/design", async (req, res) => {
  try {
    if (!KEY) return res.status(500).json({ error: "Server key is not set." });
    if (limited(req.ip)) return res.status(429).json({ error: "Limit reached. Try again in an hour." });
    const { image, mime = "image/jpeg", budget, currency = "EUR", style = "" } = req.body || {};
    if (!image || !budget) return res.status(400).json({ error: "Photo and budget are required." });
    const ctx = { image, mime, budget, currency, style };
    const p = await plan(ctx);
    const concepts = p.concepts || [];
    const order = concepts.map((_, i) => i).sort((a, b) => (b === p.best) - (a === p.best)).slice(0, MAX_IMAGES);
    const out = await Promise.allSettled(order.map((i) => picture(ctx, concepts[i].image_prompt)));
    out.forEach((r, k) => { if (r.status === "rejected") console.error(r.reason.message); concepts[order[k]].image = r.status === "fulfilled" ? r.value : null; });
    res.json({ space: p.space, concepts, best: p.best });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

app.listen(process.env.PORT || 3000, () => console.log("SpaceDesign AI running"));
