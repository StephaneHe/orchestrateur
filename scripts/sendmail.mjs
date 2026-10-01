#!/usr/bin/env node
/**
 * sendmail.mjs — chef-only email sender via Gmail SMTP
 *
 * Usage:
 *   node sendmail.mjs --to <addr> --subject <text> --body <text> [--attach <path>]
 *   node sendmail.mjs --to <addr> --subject <text> --body <text> --attach I:\path\to\file.apk
 *
 * Reads credentials from I:\orchestrateur\secrets\gmail.json
 * Only intended to be called by chef (the conductor).
 */

import nodemailer from 'nodemailer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SECRETS_PATH = path.join(__dirname, '..', 'secrets', 'gmail.json');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      args[key] = argv[i + 1] ?? '';
      i++;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.subject || !args.body) {
    console.error('Usage: node sendmail.mjs --to <addr> --subject <text> --body <text> [--attach <path>]');
    process.exit(1);
  }

  let creds;
  try {
    creds = JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf8'));
  } catch (e) {
    console.error(`[sendmail] Cannot read credentials: ${e.message}`);
    process.exit(1);
  }

  const to = args.to || creds.defaultTo;

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: creds.user,
      pass: creds.appPassword,
    },
  });

  const mailOptions = {
    from: `"Orchestre IA" <${creds.user}>`,
    to,
    subject: args.subject,
    text: args.body,
  };

  if (args.attach) {
    const attachPath = path.resolve(args.attach);
    if (!fs.existsSync(attachPath)) {
      console.error(`[sendmail] Attachment not found: ${attachPath}`);
      process.exit(1);
    }
    mailOptions.attachments = [{
      filename: path.basename(attachPath),
      path: attachPath,
    }];
  }

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log(`[sendmail] Sent OK → ${to} (messageId: ${info.messageId})`);
  } catch (e) {
    console.error(`[sendmail] Failed: ${e.message}`);
    process.exit(1);
  }
}

main();
