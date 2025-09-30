import "dotenv/config";
import { Vonage } from "@vonage/server-sdk";
import { readFileSync } from "fs";

const privateKeyContent = readFileSync(process.env.VONAGE_PRIVATE_KEY, "utf8");

export const vonage = new Vonage({
  applicationId: process.env.VONAGE_APPLICATION_ID,
  privateKey: privateKeyContent,
  apiKey: process.env.VONAGE_API_KEY,
  apiSecret: process.env.VONAGE_API_SECRET,
});
