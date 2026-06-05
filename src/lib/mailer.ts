import nodemailer, { type Transporter } from "nodemailer";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

// A WhatsApp message can be either:
//  · a free-form text — only delivered by Meta if the recipient has messaged
//    the business in the last 24 hours, OR
//  · a pre-approved template message — required for proactive
//    business-initiated sends (like our flat-owner invite).
// In dev (no env vars) the console sender prints whichever is present.
export interface WhatsAppTemplate {
  name: string;
  language: string;
  variables: string[];
}

export interface WhatsAppMessage {
  to: string;
  text?: string;
  template?: WhatsAppTemplate;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export interface WhatsAppSender {
  send(message: WhatsAppMessage): Promise<void>;
}

const consoleMailer: Mailer = {
  async send({ to, subject, text }) {
    const divider = "─".repeat(72);
    console.log(`\n${divider}`);
    console.log(`[mail] To:      ${to}`);
    console.log(`[mail] Subject: ${subject}`);
    console.log(divider);
    console.log(text);
    console.log(`${divider}\n`);
  },
};

// ---------------------------------------------------------------------------
// SMTP sender (nodemailer)
// ---------------------------------------------------------------------------
// Activated when SMTP_HOST + SMTP_USER + SMTP_PASS are all set.
//   · SMTP_HOST       — e.g. sandbox.smtp.mailtrap.io
//   · SMTP_PORT       — default 587
//   · SMTP_USER       — auth username
//   · SMTP_PASS       — auth password
//   · SMTP_SECURE     — "true" to use TLS-on-connect (port 465). Default false.
//   · MAIL_FROM       — From: header. Defaults to "NivasHub <no-reply@nivashub.local>".

function createSmtpMailer(): Mailer | null {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return null;

  const port = Number(process.env.SMTP_PORT ?? 587);
  const secure = String(process.env.SMTP_SECURE ?? "false").toLowerCase() === "true";
  const from = process.env.MAIL_FROM ?? "NivasHub <no-reply@nivashub.local>";

  const transporter: Transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });

  return {
    async send({ to, subject, text }) {
      const info = await transporter.sendMail({ from, to, subject, text });
      console.log(`[mail] sent to ${to} (id=${info.messageId})`);
    },
  };
}

const consoleWhatsApp: WhatsAppSender = {
  async send({ to, text, template }) {
    const divider = "═".repeat(72);
    console.log(`\n${divider}`);
    console.log(`[whatsapp] To: ${to}`);
    if (template) {
      console.log(`[whatsapp] Template: ${template.name} (${template.language})`);
      template.variables.forEach((v, i) => console.log(`[whatsapp]   {{${i + 1}}} = ${v}`));
    }
    console.log(divider);
    if (text) console.log(text);
    console.log(`${divider}\n`);
  },
};

// ---------------------------------------------------------------------------
// Meta WhatsApp Cloud API sender
// ---------------------------------------------------------------------------
// Activated when all of the required env vars are set:
//   · WHATSAPP_ACCESS_TOKEN        — permanent system-user token from Meta
//   · WHATSAPP_PHONE_NUMBER_ID     — the WhatsApp Business phone number's ID
//   · WHATSAPP_TEMPLATE_NAME       — name of an approved template
//                                     (defaults to "nivashub_flat_owner_invite")
//   · WHATSAPP_TEMPLATE_LANGUAGE   — template's language code (defaults to "en")
//   · WHATSAPP_API_VERSION         — Graph API version (defaults to "v20.0")
//
// Phone normalization: Meta expects digits-only in E.164 (no leading "+",
// spaces, dashes or parentheses). We strip those and prefix the country code
// from WHATSAPP_DEFAULT_COUNTRY_CODE (default "91") when the input has no
// country code.

function normalizePhoneE164(input: string, defaultCountryCode: string): string {
  let digits = input.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) digits = digits.slice(1);
  if (digits.length === 10) digits = `${defaultCountryCode}${digits}`;
  return digits;
}

function createMetaWhatsAppSender(): WhatsAppSender | null {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) return null;

  const apiVersion = process.env.WHATSAPP_API_VERSION || "v20.0";
  const defaultTemplateName = process.env.WHATSAPP_TEMPLATE_NAME || "nivashub_flat_owner_invite";
  const defaultTemplateLanguage = process.env.WHATSAPP_TEMPLATE_LANGUAGE || "en";
  const defaultCountryCode = (process.env.WHATSAPP_DEFAULT_COUNTRY_CODE || "91").replace(/\D/g, "");
  const endpoint = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;

  return {
    async send({ to, text, template }) {
      const recipient = normalizePhoneE164(to, defaultCountryCode);

      const body = template
        ? {
            messaging_product: "whatsapp",
            to: recipient,
            type: "template",
            template: {
              name: template.name || defaultTemplateName,
              language: { code: template.language || defaultTemplateLanguage },
              components: [
                {
                  type: "body",
                  parameters: template.variables.map((value) => ({ type: "text", text: value })),
                },
              ],
            },
          }
        : {
            messaging_product: "whatsapp",
            to: recipient,
            type: "text",
            text: { body: text ?? "" },
          };

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        let detail: unknown = await response.text();
        try {
          detail = JSON.parse(detail as string);
        } catch {
          // keep as text
        }
        throw new Error(
          `[whatsapp] Meta API error ${response.status}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`,
        );
      }
    },
  };
}

const metaSender = createMetaWhatsAppSender();
if (metaSender) {
  console.log("[whatsapp] Meta Cloud API sender active.");
} else {
  console.log("[whatsapp] WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID not set — using console logger.");
}

const smtpMailer = createSmtpMailer();
if (smtpMailer) {
  console.log(`[mail] SMTP sender active (host=${process.env.SMTP_HOST}).`);
} else {
  console.log("[mail] SMTP_HOST / SMTP_USER / SMTP_PASS not set — using console logger.");
}

export const mailer: Mailer = smtpMailer ?? consoleMailer;
export const whatsapp: WhatsAppSender = metaSender ?? consoleWhatsApp;

export function buildApartmentWelcomeMail(args: {
  apartmentName: string;
  apartmentCode: string;
  adminName: string;
  email: string;
  tempPassword: string;
  loginUrl: string;
}): MailMessage {
  const { apartmentName, apartmentCode, adminName, email, tempPassword, loginUrl } = args;
  return {
    to: email,
    subject: `Welcome to NivasHub — login details for ${apartmentName}`,
    text: [
      `Hello ${adminName},`,
      "",
      `Your society ${apartmentName} has been registered on NivasHub.`,
      `You can now log in and finish setting up your blocks, flats and residents.`,
      "",
      `Login URL:        ${loginUrl}`,
      `Apartment code:   ${apartmentCode}`,
      `Email:            ${email}`,
      `Temporary password: ${tempPassword}`,
      "",
      `Please change your password after your first login.`,
      "",
      `— NivasHub`,
    ].join("\n"),
  };
}

interface OwnerInviteArgs {
  apartmentName: string;
  apartmentCode: string;
  ownerName: string;
  flatNumber: string;
  email: string | null;
  mobile: string | null;
  tempPassword: string | null; // null when re-attaching an existing account
  loginUrl: string;
}

export function buildFlatOwnerWelcomeMail(args: OwnerInviteArgs): MailMessage | null {
  if (!args.email) return null;
  const { apartmentName, apartmentCode, ownerName, flatNumber, email, tempPassword, loginUrl } = args;
  const passwordSection = tempPassword
    ? [`Email:              ${email}`, `Temporary password: ${tempPassword}`, "", `Please change your password after your first login.`]
    : [`Email:              ${email}`, "", `Use the existing password on your NivasHub account. Reset it from the login page if you've forgotten it.`];
  return {
    to: email,
    subject: `You're invited to NivasHub — flat ${flatNumber} at ${apartmentName}`,
    text: [
      `Hello ${ownerName},`,
      "",
      `You have been added as the owner of flat ${flatNumber} at ${apartmentName} on NivasHub.`,
      `Through NivasHub you can see announcements, book amenities, manage visitor passes, and update your flat's details.`,
      "",
      `Login URL:          ${loginUrl}`,
      `Apartment code:     ${apartmentCode}`,
      ...passwordSection,
      "",
      `— NivasHub`,
    ].join("\n"),
  };
}

// Template message body must match the 6-variable approved template
// `nivashub_flat_owner_invite`:
//   Hello {{1}}, you are now the registered owner of flat {{2}} at {{3}}.
//   Apartment code: {{4}}. Email: {{5}}. Temporary password: {{6}}.
//
// Variables:
//   {{1}} owner name
//   {{2}} flat number
//   {{3}} apartment name
//   {{4}} apartment code
//   {{5}} email (or "the email registered for this flat" when none)
//   {{6}} temp password (or "your existing NivasHub password" when not rotated)
export function buildFlatOwnerWelcomeWhatsApp(args: OwnerInviteArgs): WhatsAppMessage | null {
  if (!args.mobile) return null;
  const { apartmentName, apartmentCode, ownerName, flatNumber, email, mobile, tempPassword, loginUrl } = args;

  const templateName = process.env.WHATSAPP_TEMPLATE_NAME || "nivashub_flat_owner_invite";
  const templateLanguage = process.env.WHATSAPP_TEMPLATE_LANGUAGE || "en";

  const variables = [
    ownerName,
    flatNumber,
    apartmentName,
    apartmentCode,
    email ?? "the email registered for this flat",
    tempPassword ?? "your existing NivasHub password",
  ];

  // Fallback free-form text (only used by the console logger or a 24h
  // service-window session). Real production sends always go via the template.
  const lines = [
    `*NivasHub — welcome, ${ownerName}!*`,
    "",
    `You have been added as the owner of flat *${flatNumber}* at *${apartmentName}*.`,
    "",
    `Login here: ${loginUrl}`,
    `Apartment code: *${apartmentCode}*`,
  ];
  if (email) lines.push(`Email: ${email}`);
  if (tempPassword) lines.push(`Temporary password: *${tempPassword}*`, "", `Please change your password after your first login.`);
  else lines.push("", `Use your existing NivasHub password. Reset it from the login page if you've forgotten it.`);

  return {
    to: mobile,
    text: lines.join("\n"),
    template: { name: templateName, language: templateLanguage, variables },
  };
}

export async function sendOwnerInvite(args: OwnerInviteArgs): Promise<{ email: boolean; whatsapp: boolean }> {
  const result = { email: false, whatsapp: false };
  const mail = buildFlatOwnerWelcomeMail(args);
  if (mail) {
    try {
      await mailer.send(mail);
      result.email = true;
    } catch (err) {
      console.error("[mail] failed to send owner invite", err);
    }
  }

  // Optionally disable WhatsApp sends if the server is configured to use
  // email-only invites. Set DISABLE_WHATSAPP=true in the environment to
  // prevent WhatsApp messages from being sent (useful when you prefer
  // delivering login details by email only, e.g. via Gmail SMTP).
  const disableWhatsApp = String(process.env.DISABLE_WHATSAPP ?? "false").toLowerCase() === "true";
  if (!disableWhatsApp) {
    const wa = buildFlatOwnerWelcomeWhatsApp(args);
    if (wa) {
      try {
        await whatsapp.send(wa);
        result.whatsapp = true;
      } catch (err) {
        console.error("[whatsapp] failed to send owner invite", err);
      }
    }
  } else {
    if (!result.email) {
      // nothing to send, but log for visibility
      console.log("[invite] DISABLE_WHATSAPP=true and no email available — no invite sent");
    } else {
      console.log("[invite] DISABLE_WHATSAPP=true — WhatsApp suppressed, email sent");
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Complaint emails
// ---------------------------------------------------------------------------

interface ComplaintMailBase {
  apartmentName: string;
  flatNumber: string;
  complaintId: string;
  title: string;
  category: string;
  priority: string;
  loginUrl: string;
}

export function buildComplaintCreatedAdminMail(args: ComplaintMailBase & {
  adminEmail: string;
  raisedByName: string;
}): MailMessage {
  return {
    to: args.adminEmail,
    subject: `New complaint from flat ${args.flatNumber} — ${args.title}`,
    text: [
      `A new complaint has been raised at ${args.apartmentName}.`,
      "",
      `Flat:       ${args.flatNumber}`,
      `Raised by:  ${args.raisedByName}`,
      `Category:   ${args.category}`,
      `Priority:   ${args.priority}`,
      `Title:      ${args.title}`,
      "",
      `Open it here: ${args.loginUrl}`,
      "",
      `— NivasHub`,
    ].join("\n"),
  };
}

export function buildComplaintStatusChangedMail(args: ComplaintMailBase & {
  to: string;
  ownerName: string;
  fromStatus: string;
  toStatus: string;
}): MailMessage {
  return {
    to: args.to,
    subject: `Your complaint is now "${args.toStatus}" — ${args.title}`,
    text: [
      `Hello ${args.ownerName},`,
      "",
      `The status of your complaint at ${args.apartmentName} has been updated.`,
      "",
      `Flat:       ${args.flatNumber}`,
      `Title:      ${args.title}`,
      `Status:     ${args.fromStatus} → ${args.toStatus}`,
      "",
      `Open it here: ${args.loginUrl}`,
      "",
      `— NivasHub`,
    ].join("\n"),
  };
}

export function buildComplaintReplyMail(args: ComplaintMailBase & {
  to: string;
  ownerName: string;
  replierName: string;
  preview: string;
}): MailMessage {
  return {
    to: args.to,
    subject: `New reply on your complaint — ${args.title}`,
    text: [
      `Hello ${args.ownerName},`,
      "",
      `${args.replierName} replied to your complaint at ${args.apartmentName}:`,
      "",
      args.preview,
      "",
      `Open the conversation: ${args.loginUrl}`,
      "",
      `— NivasHub`,
    ].join("\n"),
  };
}

// ---------------------------------------------------------------------------
// Maintenance payment emails
// ---------------------------------------------------------------------------

interface PaymentMailBase {
  apartmentName: string;
  flatNumber: string;
  reference: string;
  amountInr: number;
  months: string; // e.g. "Jun 2026, Jul 2026"
  loginUrl: string;
}

export function buildPaymentSubmittedOwnerMail(args: PaymentMailBase & {
  to: string;
  ownerName: string;
}): MailMessage {
  return {
    to: args.to,
    subject: `Maintenance payment of ₹${args.amountInr} received — pending verification`,
    text: [
      `Hello ${args.ownerName},`,
      "",
      `Your maintenance payment of ₹${args.amountInr} for ${args.apartmentName} is pending verification.`,
      "",
      `Flat:        ${args.flatNumber}`,
      `Months:      ${args.months}`,
      `Reference:   ${args.reference}`,
      "",
      `The management committee will verify your payment screenshot against the society's bank statement and send you a receipt once approved.`,
      "",
      `View status: ${args.loginUrl}`,
      "",
      `— NivasHub`,
    ].join("\n"),
  };
}

export function buildPaymentSubmittedAdminMail(args: PaymentMailBase & {
  adminEmail: string;
  paidByName: string;
}): MailMessage {
  return {
    to: args.adminEmail,
    subject: `New maintenance payment from flat ${args.flatNumber} — ₹${args.amountInr}`,
    text: [
      `A maintenance payment is pending your verification at ${args.apartmentName}.`,
      "",
      `Flat:        ${args.flatNumber}`,
      `Paid by:     ${args.paidByName}`,
      `Amount:      ₹${args.amountInr}`,
      `Months:      ${args.months}`,
      `Reference:   ${args.reference}`,
      "",
      `Review and verify: ${args.loginUrl}`,
      "",
      `— NivasHub`,
    ].join("\n"),
  };
}

export function buildPaymentApprovedOwnerMail(args: PaymentMailBase & {
  to: string;
  ownerName: string;
  receiptNumber: string;
}): MailMessage {
  return {
    to: args.to,
    subject: `Maintenance payment approved — receipt ${args.receiptNumber}`,
    text: [
      `Hello ${args.ownerName},`,
      "",
      `Your maintenance payment has been approved successfully.`,
      "",
      `Flat:        ${args.flatNumber}`,
      `Amount:      ₹${args.amountInr}`,
      `Months:      ${args.months}`,
      `Reference:   ${args.reference}`,
      `Receipt:     ${args.receiptNumber}`,
      "",
      `Download receipt: ${args.loginUrl}`,
      "",
      `— NivasHub`,
    ].join("\n"),
  };
}

export function buildPaymentRejectedOwnerMail(args: PaymentMailBase & {
  to: string;
  ownerName: string;
  remarks: string | null;
}): MailMessage {
  return {
    to: args.to,
    subject: `Maintenance payment could not be verified`,
    text: [
      `Hello ${args.ownerName},`,
      "",
      `Your maintenance payment for ${args.apartmentName} could not be verified.`,
      "",
      `Flat:        ${args.flatNumber}`,
      `Amount:      ₹${args.amountInr}`,
      `Months:      ${args.months}`,
      `Reference:   ${args.reference}`,
      args.remarks ? `Reason:      ${args.remarks}` : "",
      "",
      `Please re-submit the payment with a clearer screenshot, or contact the management committee.`,
      "",
      `Open: ${args.loginUrl}`,
      "",
      `— NivasHub`,
    ].filter(Boolean).join("\n"),
  };
}

export function generateTempPassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < 12; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}
