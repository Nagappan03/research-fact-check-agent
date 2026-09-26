#!/usr/bin/env node
/**
 * Emails a heads-up when the scheduled workflow finds topics.json fully
 * researched, so that's visible the same way a brief landing in the inbox
 * is - instead of the run just quietly skipping and no one noticing until
 * they wonder why no brief showed up.
 *
 * There's no automated step that invents new topics - the pipeline is a
 * deliberate, reviewed decision each time, made in chat and written into
 * content-creation.md. This email is the reminder to do that, and to copy
 * the new topics into topics.json in this repo too.
 */

import dotenv from "dotenv";
import nodemailer from "nodemailer";

dotenv.config({ quiet: true });

async function main() {
  const { GMAIL_USER, GMAIL_APP_PASSWORD } = process.env;
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
    console.error(
      "GMAIL_USER and/or GMAIL_APP_PASSWORD is not set. Add them to .env or the environment.",
    );
    process.exit(1);
  }

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
  });

  const subject = "Research Agent: topic queue is empty";
  const text = `The scheduled Research Agent run found every topic in topics.json already researched, so tonight's run did nothing.

This isn't an error - it just means the queue needs refilling. Add the next batch of topics to topics.json in github.com/Nagappan03/research-fact-check-agent (same titles you're adding to content-creation.md's pipeline), commit, and the next scheduled run will pick up from there automatically.`;

  try {
    console.log(`Sending "${subject}" to ${GMAIL_USER}...`);
    const info = await transporter.sendMail({ from: GMAIL_USER, to: GMAIL_USER, subject, text });
    console.log(`Sent. messageId: ${info.messageId}`);
  } catch (err) {
    console.error(`Failed to send email: ${err.message}`);
    process.exit(1);
  }
}

main();
