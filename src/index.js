import "dotenv/config";
import express from "express";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { GoogleGenAI } from "@google/genai";
import { Channels, RCSImage } from "@vonage/messages";
import { verifySignature } from "@vonage/jwt";
import { vonage } from "./vonage.js";
import fetch from "node-fetch";

const app = express();
app.set("trust proxy", true); // respect ngrok/proxies for req.protocol
const PORT = process.env.PORT || 3000;

const MODEL_ID = "gemini-2.5-flash-image";
const IMAGE_MAX_BYTES = Number(process.env.IMAGE_MAX_BYTES || 12 * 1024 * 1024);
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 10 * 60 * 1000); // 10 minutes

// Use env, else absolute /Pictures if present, else cwd/Pictures
const PHOTOS_PATH =
  process.env.PHOTOS_PATH ||
  (fsSync.existsSync("/Pictures") ? "/Pictures" : path.resolve(process.cwd(), "Pictures"));

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
app.use(express.json({ limit: "50mb" }));


const userSessions = {};
let lastWebhook = null;

// ---------- helpers ----------
const log = (...a) => console.log(...a);
const warn = (...a) => console.warn(...a);
const err = (...a) => console.error(...a);

function now() { return Date.now(); }

function getSession(userPhone) {
  const s = userSessions[userPhone];
  if (!s) {
    userSessions[userPhone] = { lastUpdated: now(), inProgress: false };
    return userSessions[userPhone];
  }
  // TTL expiry -> hard reset
  if (now() - (s.lastUpdated || 0) > SESSION_TTL_MS) {
    userSessions[userPhone] = { lastUpdated: now(), inProgress: false };
  }
  return userSessions[userPhone];
}

function resetSession(userPhone) {
  userSessions[userPhone] = { lastUpdated: now(), inProgress: false };
}

function updateSession(userPhone, patch) {
  const s = getSession(userPhone);
  Object.assign(s, patch);
  s.lastUpdated = now();
}

function extractText(msg) {
  return (
    msg?.text ??
    msg?.message?.text ??
    msg?.message?.content?.text ??
    msg?.message?.content?.message?.text ??
    null
  );
}
function extractMediaUrl(msg) {
  return (
    msg?.image?.url ??
    msg?.message?.image?.url ??
    msg?.message?.content?.image?.url ??
    msg?.content?.image?.url ??
    msg?.message?.content?.message?.image?.url ??
    msg?.file?.url ??
    msg?.message?.file?.url ??
    msg?.message?.content?.file?.url ??
    msg?.content?.file?.url ??
    null
  );
}

async function head(url) {
  try { return await fetch(url, { method: "HEAD" }); } catch { return null; }
}
async function downloadImageAsBase64IfSupported(url) {
  const h = await head(url);
  const headCT = (h?.headers?.get("content-type") || "").toLowerCase();
  const headLen = Number(h?.headers?.get("content-length") || 0);
  const headStatus = h?.status || 0;

  if (headStatus === 401 || headStatus === 403) {
    const e = new Error(`Forbidden (${headStatus})`); e.code = "FETCH_FORBIDDEN"; throw e;
  }

  const res = await fetch(url);
  if (!res.ok) {
    const e = new Error(`GET ${url} -> ${res.status}`);
    e.code = res.status === 401 || res.status === 403 ? "FETCH_FORBIDDEN" : "FETCH_FAILED";
    throw e;
  }
  const buf = await res.buffer();
  const ct = headCT || (res.headers.get("content-type") || "").toLowerCase();
  const len = headLen || buf.length;

  if (len > IMAGE_MAX_BYTES) {
    const e = new Error(`Image too large (${len} bytes)`); e.code = "TOO_LARGE"; e.size = len; throw e;
  }

  const isPng = ct.includes("image/png");
  const isJpeg = ct.includes("image/jpeg") || ct.includes("image/jpg");
  if (!(isPng || isJpeg)) {
    const e = new Error(`Unsupported image type: ${ct}`);
    e.code = ct.includes("image/webp")
      ? "UNSUPPORTED_WEBP"
      : (ct.includes("image/heic") || ct.includes("image/heif"))
      ? "UNSUPPORTED_HEIC"
      : "UNSUPPORTED_TYPE";
    e.contentType = ct;
    throw e;
  }
  return { base64: buf.toString("base64"), mime: isPng ? "image/png" : "image/jpeg", size: len, contentType: ct };
}

function findInlineData(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (obj.inlineData?.data) return obj.inlineData;
  if (obj.inline_data?.data) return obj.inline_data;
  if (Array.isArray(obj)) { for (const it of obj) { const f = findInlineData(it); if (f) return f; } }
  for (const k of Object.keys(obj)) { try { const f = findInlineData(obj[k]); if (f) return f; } catch {} }
  return null;
}

async function collectFromStream(streamResp) {
  let imagePart = null;
  let text = "";
  for await (const ev of streamResp) {
    if (ev?.text) text += ev.text;
    const maybe = findInlineData(ev);
    if (maybe && !imagePart) imagePart = maybe;
  }
  return { imagePart, text };
}

function buildPublicUrl(req, outFile) {
  const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
  return `${base}/photos/${outFile}`;
}

const verifyWebhookSignature = (req, res, next) => {
  if (process.env.SKIP_VONAGE_JWT === "true") return next();
  try {
    const jwtToken = req.headers.authorization?.split(" ")[1];
    if (!jwtToken) return res.status(401).json({ status: 401, title: "Unauthorized", detail: "No JWT token provided." });
    const ok = verifySignature(jwtToken, process.env.VONAGE_API_SIGNATURE_SECRET);
    if (!ok) return res.status(401).json({ status: 401, title: "Unauthorized", detail: "Invalid JWT signature." });
    next();
  } catch {
    return res.status(401).json({ status: 401, title: "Unauthorized", detail: "JWT verification failed." });
  }
};

async function fileToBase64(filePath) {
  const fileBuffer = await fs.readFile(filePath);
  return fileBuffer.toString("base64");
}

// ---------- routes ----------
app.get("/health", (req, res) =>
  res.json({
    ok: true,
    picturesDir: PHOTOS_PATH,
    imageMaxBytes: IMAGE_MAX_BYTES,
    sessionTtlMs: SESSION_TTL_MS,
    env: { SKIP_VONAGE_JWT: process.env.SKIP_VONAGE_JWT || "false" },
  })
);

// Vonage status webhook
app.post("/webhooks/status", verifyWebhookSignature, (req, res) => {
  lastWebhook = { time: Date.now(), headers: req.headers, body: req.body };
  log("/webhooks/status ->", JSON.stringify(req.body).slice(0, 400));
  res.status(200).end();
});

// Debug last webhook
app.get("/debug/last", (req, res) => {
  if (!lastWebhook) return res.status(404).json({ error: "no webhook seen yet" });
  res.json({ lastWebhook });
});

// Serve generated images with no cache
app.use(
  "/photos",
  express.static(PHOTOS_PATH, {
    etag: false,
    lastModified: false,
    maxAge: 0,
    setHeaders: (res) => {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
      res.setHeader("Surrogate-Control", "no-store");
    },
  })
);

// Starter message
app.get("/test", async (req, res) => {
  const to = process.env.PHONE_NUMBER;
  if (!to) return res.status(400).json({ error: "Set PHONE_NUMBER in .env" });
  try {
    await vonage.messages.send({
      channel: Channels.RCS,
      messageType: "text",
      text: "Send a selfie (PNG/JPEG) then a clothing image (PNG/JPEG). I’ll return a stylized try-on.",
      to,
      from: process.env.RCS_SENDER_ID,
    });
    res.json({ ok: true, to });
  } catch (e) {
    err("/test -> vonage send error:", e);
    res.status(500).json({ error: e.message });
  }
});

// Main inbound webhook
app.post("/webhooks/inbound", verifyWebhookSignature, async (req, res) => {
  log("/webhooks/inbound ->", JSON.stringify(req.body).slice(0, 1000));

  const msg = req.body.message || req.body;
  const userPhone = msg?.from ?? msg?.message?.from ?? req.body?.from ?? req.body?.msisdn;
  const text = extractText(msg);
  const mediaUrl = extractMediaUrl(msg);
  if (!userPhone) return res.status(200).end();

  // fetch session (auto-resets if TTL passes)
  const session = getSession(userPhone);

  // Decide type: if unlabeled, first=selfie, then clothing
  let imageType;
  if (text) {
    const lower = String(text).toLowerCase();
    if (/\b(selfie|me|face|portrait)\b/.test(lower)) imageType = "selfie";
    else if (/\b(clothing|dress|shirt|outfit|attire|wear)\b/.test(lower)) imageType = "clothing";
  }
  if (!imageType && mediaUrl) {
    imageType = session.selfie ? "clothing" : "selfie";
  }

  // Store new media
  if (mediaUrl && imageType) {
    try {
      const img = await downloadImageAsBase64IfSupported(mediaUrl);
      // If a NEW selfie arrives, reset clothing so we don't pair old clothing with fresh selfie
      if (imageType === "selfie") {
        updateSession(userPhone, { clothing: undefined });
      }
      updateSession(userPhone, {
        [imageType]: { data: img.base64, mime: img.mime, ts: now() },
      });
      log(`stored ${imageType} (mime=${img.mime}, size=${img.size || "?"})`);
    } catch (e) {
      err("download error:", e.code || e.message);
      let tip = "Please resend the image as PNG or JPEG.";
      if (e.code === "UNSUPPORTED_WEBP") tip = "That looks like a WEBP. Please resend as PNG or JPEG.";
      if (e.code === "UNSUPPORTED_HEIC") tip = "That looks like an iPhone HEIC. Please resend as PNG or JPEG.";
      if (e.code === "TOO_LARGE") tip = `That image is too large. Please send a smaller PNG/JPEG (<= ${IMAGE_MAX_BYTES} bytes).`;
      if (e.code === "FETCH_FORBIDDEN") tip = "The image link was not accessible. Please resend the image.";
      try {
        await vonage.messages.send({
          channel: Channels.RCS,
          messageType: "text",
          to: userPhone,
          from: process.env.RCS_SENDER_ID,
          text: tip,
        });
      } catch {}
    }
  }

  // If both present, generate
  const ready = session.selfie && session.clothing && !session.inProgress;
  if (ready) {
    try {
      // lock to avoid race/mixing
      updateSession(userPhone, { inProgress: true });

      const selfie = session.selfie;
      const clothing = session.clothing;
      const contents = [{
        role: "user",
        parts: [
          { inlineData: { data: selfie.data, mimeType: selfie.mime } },
          { inlineData: { data: clothing.data, mimeType: clothing.mime } },
          { text: "Create a stylized fashion mock-up by overlaying the clothing (2nd image) onto the person (1st image). Keep it clearly stylized (non-photorealistic), do not modify facial features, simple background." },
        ],
      }];
      const config = { responseModalities: ["IMAGE", "TEXT"], generationConfig: { responseMimeType: "image/png" } };

      let imagePart = null, textResponse = "";
      try {
        const streamResp = await ai.models.generateContentStream({ model: MODEL_ID, config, contents });
        const collected = await collectFromStream(streamResp);
        imagePart = collected.imagePart;
        textResponse = collected.text;

        if (!imagePart) {
          const full = await ai.models.generateContent({ model: MODEL_ID, config, contents });
          imagePart = findInlineData(full);
          if (full.text) textResponse += full.text;
          if (!imagePart && full?.candidates?.[0]) {
            warn("finishReason:", full.candidates[0].finishReason);
            if (full.candidates[0].safetyRatings) warn("safetyRatings:", JSON.stringify(full.candidates[0].safetyRatings));
          }
        }
      } catch (e) {
        err("Gemini error:", e);
      }

      if (imagePart?.data) {
        // Unique filename per generation to avoid cache
        const outFile = `tryon_${userPhone}_${Date.now()}.png`;
        const outPath = path.join(PHOTOS_PATH, outFile);
        try {
          await fs.mkdir(PHOTOS_PATH, { recursive: true });
          await fs.writeFile(outPath, Buffer.from(imagePart.data, "base64"));
          log(`saved image -> ${outPath}`);
        } catch (e) {
          err("save error:", e);
        }

        const publicUrl = buildPublicUrl(req, outFile);
        log(`public image URL: ${publicUrl}`);

        let sent = false;
        try {
          const resp = await vonage.messages.send(
            new RCSImage({
              to: userPhone,
              from: process.env.RCS_SENDER_ID,
              image: { url: publicUrl },
              text: textResponse || "Here is your (stylized) try-on preview!",
            })
          );
          log("RCSImage sent:", resp?.message_uuid || resp);
          sent = true;
        } catch (e) {
          err("RCSImage send failed, falling back:", e?.response?.data || e?.message || e);
        }

        if (!sent) {
          try {
            const resp2 = await vonage.messages.send({
              channel: Channels.RCS,
              messageType: "image",
              to: userPhone,
              from: process.env.RCS_SENDER_ID,
              image: { url: publicUrl },
              text: textResponse || "Here is your (stylized) try-on preview!",
            });
            log("RCS plain image sent:", resp2?.message_uuid || resp2);
            sent = true;
          } catch (e) {
            err("Plain image send failed:", e?.response?.data || e?.message || e);
          }
        }

        if (!sent) {
          try {
            await vonage.messages.send({
              channel: Channels.RCS,
              messageType: "text",
              to: userPhone,
              from: process.env.RCS_SENDER_ID,
              text: `Your preview is ready: ${publicUrl}`,
            });
            log("Sent fallback link as text");
          } catch (e) {
            err("Fallback text send failed:", e?.response?.data || e?.message || e);
          }
        }

        resetSession(userPhone);
        return res.status(200).end();
      } else {
        try {
          await vonage.messages.send({
            channel: Channels.RCS,
            messageType: "text",
            to: userPhone,
            from: process.env.RCS_SENDER_ID,
            text: "I couldn’t render a preview. Use a clear selfie and clothing photo (PNG/JPEG).",
          });
        } catch {}
        resetSession(userPhone);
        return res.status(200).end();
      }
    } finally {
      // Safety unlock
      const s = getSession(userPhone);
      s.inProgress = false;
    }
  }

  // If we get here, we don't have both images yet -> guidance
  const s = getSession(userPhone);
  const haveSelfie = !!s.selfie;
  const hint = haveSelfie ? "Now send a clothing image (PNG/JPEG)." : "First send a selfie (PNG/JPEG).";
  try {
    await vonage.messages.send({
      channel: Channels.RCS,
      messageType: "text",
      to: userPhone,
      from: process.env.RCS_SENDER_ID,
      text: mediaUrl || text ? hint : "Send a selfie (PNG/JPEG), then a clothing image.",
    });
  } catch {}
  res.status(200).end();
});

// Local test (non-RCS)
app.post("/try-on", verifyWebhookSignature, async (req, res) => {
  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: "GEMINI_API_KEY not set" });
  if (!req.body.clothingImageData) return res.status(400).json({ error: "Provide clothingImageData (base64)" });

  const selfie = await fileToBase64(path.join(PHOTOS_PATH, "me.png"));
  const clothing = req.body.clothingImageData;
  const clothingMimeType = req.body.clothingMimeType || "image/jpeg";

  const contents = [{
    role: "user",
    parts: [
      { inlineData: { data: selfie, mimeType: "image/png" } },
      { inlineData: { data: clothing, mimeType: clothingMimeType } },
      { text: "Stylized clothing overlay. Non-photorealistic. Do not modify facial features." },
    ],
  }];
  const config = { responseModalities: ["IMAGE", "TEXT"], generationConfig: { responseMimeType: "image/png" } };

  let imagePart = null, textResponse = "";
  try {
    const streamResp = await ai.models.generateContentStream({ model: MODEL_ID, config, contents });
    const collected = await collectFromStream(streamResp);
    imagePart = collected.imagePart;
    textResponse = collected.text;
    if (!imagePart) {
      const full = await ai.models.generateContent({ model: MODEL_ID, config, contents });
      imagePart = findInlineData(full);
      if (full.text) textResponse += full.text;
    }
  } catch (e) { err("try-on -> Gemini error:", e); }

  if (imagePart?.data) {
    const outFile = `tryon_local_${Date.now()}.png`;
    const outPath = path.join(PHOTOS_PATH, outFile);
    await fs.mkdir(PHOTOS_PATH, { recursive: true });
    await fs.writeFile(outPath, Buffer.from(imagePart.data, "base64"));
    const url = buildPublicUrl(req, outFile);
    return res.json({ success: true, imageUrl: url, mimeType: imagePart.mimeType || "image/png", textResponse });
  } else {
    return res.status(500).json({ success: false, message: "No image generated", textResponse });
  }
});

// 404 + error handler
app.use((req, res) => res.status(404).json({ error: "Not found" }));
app.use((err, req, res, next) => {
  err("Express error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// ---------- boot ----------
(async () => {
  try {
    await fs.mkdir(PHOTOS_PATH, { recursive: true });
    log(`📸 Serving from: ${PHOTOS_PATH}`);
  } catch (e) { err("mkdir error:", e); }
  app.listen(PORT, () => log(`Server listening on port ${PORT}`));
})();
