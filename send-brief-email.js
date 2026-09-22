#!/usr/bin/env node
/**
 * Emails a previously-generated research brief to yourself via Gmail SMTP.
 *
 * Usage:  node send-brief-email.js "Vector Databases & Embeddings"
 *
 * Expects output/<topic-slug>.md to already exist (run research.js first).
 * Reads GMAIL_USER and GMAIL_APP_PASSWORD from the environment - use a Gmail
 * App Password (myaccount.google.com/apppasswords), not your normal password.
 */

import dotenv from "dotenv";
import nodemailer from "nodemailer";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { slugify } from "./lib/slug.js";

dotenv.config({ quiet: true });

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(ROOT_DIR, "output");

async function main() {
  const topic = process.argv.slice(2).join(" ").trim();
  if (!topic) {
    console.error('Usage: node send-brief-email.js "topic name"');
    process.exit(1);
  }

  const { GMAIL_USER, GMAIL_APP_PASSWORD } = process.env;
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
    console.error(
      "GMAIL_USER and/or GMAIL_APP_PASSWORD is not set. Add them to .env or the environment.",
    );
    process.exit(1);
  }

  // Same slug function research.js used to name the file, so this always
  // finds the file that matches the topic you asked for.
  const slug = slugify(topic);
  const briefPath = path.join(OUTPUT_DIR, `${slug}.md`);

  let briefMarkdown;
  try {
    briefMarkdown = await fs.readFile(briefPath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      console.error(`Brief not found: ${briefPath}\nRun research.js "${topic}" first.`);
    } else {
      console.error(`Could not read ${briefPath}: ${err.message}`);
    }
    process.exit(1);
  }

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
  });

  const subject = `Research Brief: ${topic}`; // exact format - something else searches Gmail for this

  try {
    console.log(`Sending "${subject}" to ${GMAIL_USER}...`);
    const info = await transporter.sendMail({
      from: GMAIL_USER,
      to: GMAIL_USER, // emailing yourself
      subject,
      text: briefMarkdown, // plain text, markdown source as-is
    });
    console.log(`Sent. messageId: ${info.messageId}`);
  } catch (err) {
    console.error(`Failed to send email: ${err.message}`);
    process.exit(1);
  }
}

main();
