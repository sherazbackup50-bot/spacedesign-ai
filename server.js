const express = require("express");
const path = require("path");

const app = express();
app.use(express.json({ limit: "12mb" }));
app.use(express.static(__dirname));
const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5-5";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-image";
const MAX_IMAGES = Number(process.env.MAX_IMAGES || 2);
const HOURLY_LIMIT = Number(process.env.HOURLY_LIMIT || 10);

// Simple per-IP limit so nobody can drain your API credit
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 3600000);
  if (list.length >= HOURLY_LIMIT) { hits.set(ip, list); return true; }
  list.push(now); hits.set(ip, list); return false;
}

async function askClaude({ image, mime, budget, currency, style }) {
  const prompt =
    `You are an expert interior, landscape and architectural designer. Study the attached photo of a space. ` +
    `Budget: ${budget} ${currency}. ${style ? "Preferred style: " + style + ". " : ""}` +
    `Return ONLY JSON, no markdown: {"space":"short description of the space type, size, light and condition",` +
    `"concepts":[3 items, each {"name":"","style":"","summary":"one sentence","palette":["#hex","#hex","#hex","#hex"],` +
    `"changes":["4 specific changes"],"cost_low":number,"cost_high":number,"within_budget":true or false,` +
    `"image_prompt":"detailed instruction to redesign THIS exact space in this style, keep the room structure and camera angle, photorealistic"}],` +
    `"best":index 0-2 of the concept that looks most beautiful within the budget}. ` +
    `Costs are realistic rough estimates in ${currency}. Keep at least the best concept within budget.`;

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": CLAUDE_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 2000,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mime, data: image } },
          { type: "text", text: prompt },
        ],
      }],
    }),
  });
  if (!r.ok) throw new Error("Claude error " + r.status + ": " + (await r.text()).slice(0, 300));
  const data = await r.json();
  const text = data.content.map((p) => p.text || "").join("").replace(/```json|```/g, "").trim();
  return JSON.parse(text);
}

async function makePicture({ image, mime }, prompt) {
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": GEMINI_KEY },
      body: JSON.stringify({
        contents: [{ parts: [
          { text: "Edit this photo: " + prompt + " Keep the same room layout, walls, windows and camera angle." },
          { inline_data: { mime_type: mime, data: image } },
        ] }],
        generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
      }),
    }
  );
  if (!r.ok) throw new Error("Gemini error " + r.status + ": " + (await r.text()).slice(0, 300));
  const data = await r.json();
  const parts = (data.candidates?.[0]?.content?.parts) || [];
  const img = parts.map((p) => p.inlineData || p.inline_data).find(Boolean);
  if (!img) throw new Error("Gemini returned no image");
  return `data:${img.mimeType || img.mime_type};base64,${img.data}`;
}

app.post("/api/design", async (req, res) => {
  try {
    if (!CLAUDE_KEY || !GEMINI_KEY) return res.status(500).json({ error: "Server keys are not set." });
    if (limited(req.ip)) return res.status(429).json({ error: "Limit reached. Please try again in an hour." });
    const { image, mime = "image/jpeg", budget, currency = "EUR", style = "" } = req.body || {};
    if (!image || !budget) return res.status(400).json({ error: "Photo and budget are required." });

    const ctx = { image, mime, budget, currency, style };
    const plan = await askClaude(ctx);
    const concepts = plan.concepts || [];

    // Generate pictures for the best concept first, then the next ones
    const order = concepts.map((_, i) => i).sort((a, b) => (b === plan.best) - (a === plan.best)).slice(0, MAX_IMAGES);
    const results = await Promise.allSettled(order.map((i) => makePicture(ctx, concepts[i].image_prompt)));
    results.forEach((r, k) => { concepts[order[k]].image = r.status === "fulfilled" ? r.value : null; });

    res.json({ space: plan.space, concepts, best: plan.best });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

app.listen(process.env.PORT || 3000, () => console.log("SpaceDesign AI running"));
