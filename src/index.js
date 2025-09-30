import "dotenv/config";
import express from "express";
import fs from "fs/promises";
import path from "path";
import { GoogleGenAI } from "@google/genai";
import { Channels, RCSImage } from "@vonage/messages";
import { verifySignature } from "@vonage/jwt";
import { vonage } from "./vonage.js";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;
const PHOTOS_PATH = path.resolve(process.cwd(), "Pictures");
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
app.use(express.json({ limit: "50mb" }));
const userImages = {};
async function downloadImageAsBase64(url) {
  const res = await fetch(url);
  const buffer = await res.buffer();
  return buffer.toString("base64");
}
const verifyWebhookSignature = (req, res, next) => {
  try {
    const jwtToken = req.headers.authorization?.split(" ")[1];
    if (!jwtToken) {
      return res.status(401).json({
        status: 401,
        title: "Unauthorized",
        detail: "No JWT token provided.",
      });
    }
    const isValid = verifySignature(
      jwtToken,
      process.env.VONAGE_API_SIGNATURE_SECRET
    );
    if (!isValid) {
      return res.status(401).json({
        status: 401,
        title: "Unauthorized",
        detail: "Invalid JWT signature.",
      });
    }
    next();
  } catch {
    return res.status(401).json({
      status: 401,
      title: "Unauthorized",
      detail: "JWT verification failed.",
    });
  }
};
async function fileToBase64(filePath) {
  try {
    const fileBuffer = await fs.readFile(filePath);
    return fileBuffer.toString("base64");
  } catch (error) {
    throw new Error(`Error reading file ${filePath}: ${error.message}`);
  }
}

app.get("/test", async (req, res) => {
  const to = process.env.PHONE_NUMBER;
  if (!to) return res.status(400).json({ error: "Set PHONE_NUMBER in .env" });
  try {
    await vonage.messages.send({
      channel: Channels.RCS,
      messageType: "text",
      text: "Hi! Send me a selfie and a clothing image to try on.",
      to,
      from: process.env.RCS_SENDER_ID,
    });
    res.json({ ok: true, to });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/webhooks/inbound", verifyWebhookSignature, async (req, res) => {
  const msg = req.body.message || req.body;
  const userPhone = msg?.from ?? msg?.message?.from ?? req.body?.from;
  const media = msg?.image ?? msg?.message?.image;
  const text = msg?.text ?? msg?.message?.text;
  if (!userPhone) return res.status(200).end();
  let imageType;
  if (
    text?.toLowerCase().includes("selfie") ||
    text?.toLowerCase().includes("me")
  ) {
    imageType = "selfie";
  } else if (
    text?.toLowerCase().includes("clothing") ||
    text?.toLowerCase().includes("dress") ||
    text?.toLowerCase().includes("shirt")
  ) {
    imageType = "clothing";
  }
  if (media?.url && imageType) {
    const base64 = await downloadImageAsBase64(media.url);
    if (!userImages[userPhone]) userImages[userPhone] = {};
    userImages[userPhone][imageType] = base64;
  }
  if (userImages[userPhone]?.selfie && userImages[userPhone]?.clothing) {
    const contents = [
      {
        role: "user",
        parts: [
          {
            inlineData: {
              data: userImages[userPhone].selfie,
              mimeType: "image/jpeg",
            },
          },
          {
            inlineData: {
              data: userImages[userPhone].clothing,
              mimeType: "image/jpeg",
            },
          },
          {
            text: "Try this clothing on me.",
          },
        ],
      },
    ];
    const model = "gemini-2.5-flash-image-preview";
    const config = { responseModalities: ["IMAGE", "TEXT"] };
    const response = await ai.models.generateContentStream({
      model,
      config,
      contents,
    });
    let generatedImageData = null;
    for await (const chunk of response) {
      if (chunk.candidates?.[0]?.content?.parts?.[0]?.inlineData) {
        generatedImageData = chunk.candidates[0].content.parts[0].inlineData;
        break;
      }
    }
    if (generatedImageData) {
      const outPath = path.join(PHOTOS_PATH, `tryon_${userPhone}.png`);
      await fs.writeFile(
        outPath,
        Buffer.from(generatedImageData.data, "base64")
      );
      const publicUrl = `${process.env.PUBLIC_BASE_URL}/photos/tryon_${userPhone}.png`;
      const rcsMsg = new RCSImage({
        to: userPhone,
        from: process.env.RCS_SENDER_ID,
        image: { url: publicUrl },
      });
      await vonage.messages.send(rcsMsg);
      delete userImages[userPhone];
    }
  }
  res.status(200).end();
});
app.post("/try-on", verifyWebhookSignature, async (req, res) => {
  if (!process.env.GEMINI_API_KEY) {
    return res
      .status(500)
      .json({ error: "GEMINI_API_KEY environment variable is not set" });
  }
  if (!req.body.clothingImageData) {
    return res
      .status(400)
      .json({
        error:
          "No clothing image data provided. Please include clothingImageData (base64) in request body.",
      });
  }
  const defaultImagePath = path.join(PHOTOS_PATH, "me.png");
  const defaultImageBase64 = await fileToBase64(defaultImagePath);
  const clothingImageBase64 = req.body.clothingImageData;
  const clothingMimeType = req.body.clothingMimeType || "image/jpeg";
  const customPrompt =
    req.body.prompt ||
    "Given my picture, I want to try on the piece of clothing in the second picture";
  const contents = [
    {
      role: "user",
      parts: [
        {
          inlineData: {
            data: defaultImageBase64,
            mimeType: "image/png",
          },
        },
        {
          inlineData: {
            data: clothingImageBase64,
            mimeType: clothingMimeType,
          },
        },
        {
          text: customPrompt,
        },
      ],
    },
  ];
  const model = "gemini-2.5-flash-image-preview";
  const config = {
    responseModalities: ["IMAGE", "TEXT"],
  };
  const response = await ai.models.generateContentStream({
    model,
    config,
    contents,
  });
  let generatedImageData = null;
  let textResponse = "";
  for await (const chunk of response) {
    if (
      !chunk.candidates ||
      !chunk.candidates[0].content ||
      !chunk.candidates[0].content.parts
    ) {
      continue;
    }
    if (chunk.candidates?.[0]?.content?.parts?.[0]?.inlineData) {
      const inlineData = chunk.candidates[0].content.parts[0].inlineData;
      generatedImageData = {
        data: inlineData.data,
        mimeType: inlineData.mimeType,
      };
    } else if (chunk.text) {
      textResponse += chunk.text;
    }
  }
  if (generatedImageData) {
    res.json({
      success: true,
      message: "Virtual try-on completed successfully",
      imageData: generatedImageData.data,
      mimeType: generatedImageData.mimeType,
      textResponse: textResponse,
      timestamp: new Date().toISOString(),
    });
  } else {
    res.json({
      success: false,
      message: "No image was generated",
      textResponse: textResponse,
      timestamp: new Date().toISOString(),
    });
  }
});
app.use((req, res) => res.status(404).json({ error: "Not found" }));
app.use((err, req, res, next) =>
  res.status(500).json({ error: "Internal server error" })
);
app.listen(PORT);
