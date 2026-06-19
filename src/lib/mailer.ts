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
// Brevo (formerly Sendinblue) — transactional email via REST API
// ---------------------------------------------------------------------------
// Activated when EMAIL_API_KEY is set.
//   · EMAIL_API_KEY      — API v3 key from https://app.brevo.com/settings/keys/api
//   · BREVO_SENDER_NAME  — From: display name (default "NivasHub")
//   · BREVO_SENDER_EMAIL — From: email address (default "no-reply@nivashub.local")
//
// The API is called via native fetch (Node 18+) so no extra SDK or SMTP
// dependency is required, and no ports need to be open on the server.

function createBrevoMailer(): Mailer | null {
  const apiKey = process.env.EMAIL_API_KEY;
  if (!apiKey) return null;

  const senderName = process.env.BREVO_SENDER_NAME ?? "NivasHub";
  const senderEmail = process.env.BREVO_SENDER_EMAIL ?? "no-reply@nivashub.local";
  const endpoint = "https://api.brevo.com/v3/smtp/email";

  return {
    async send({ to, subject, text }) {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          sender: { name: senderName, email: senderEmail },
          to: [{ email: to }],
          subject,
          textContent: text,
        }),
      });

      if (!response.ok) {
        let detail: unknown = await response.text();
        try {
          detail = JSON.parse(detail as string);
        } catch {
          // keep as text
        }
        throw new Error(
          `[mail] Brevo API error ${response.status}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`,
        );
      }

      const data = (await response.json()) as { messageId?: string };
      console.log(`[mail] sent to ${to} (messageId=${data.messageId ?? "unknown"})`);
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

const brevoMailer = createBrevoMailer();
if (brevoMailer) {
  console.log("[mail] Brevo API sender active.");
} else {
  console.log("[mail] EMAIL_API_KEY not set — using console logger.");
}

export const mailer: Mailer = brevoMailer ?? consoleMailer;
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
  
  // Ensure we use https://nivashub.in/login if not in dev
  const finalLoginUrl = loginUrl.includes("localhost") ? loginUrl : "https://nivashub.in/login";
  
  return {
    to: email,
    subject: `🎉 Welcome to NivasHub — ${apartmentName} is now registered!`,
    text: [
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      ``,
      `Hello ${adminName},`,
      ``,
      `Welcome to NivasHub! 🏢`,
      ``,
      `Your society "${apartmentName}" has been successfully registered on our platform.`,
      `Everything is now ready for you to start managing your community.`,
      ``,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `WHAT YOU CAN NOW DO`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      ``,
      `✓ Set up your building blocks and flat inventory`,
      `✓ Add residents and manage flat ownership`,
      `✓ Post announcements and community notices`,
      `✓ Manage amenity bookings (gym, pool, courts, etc.)`,
      `✓ Track visitor passes and security`,
      `✓ Monitor maintenance payments and dues`,
      `✓ Connect your community members`,
      ``,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `YOUR LOGIN CREDENTIALS`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      ``,
      `📱 Login URL:          ${finalLoginUrl}`,
      `🏢 Apartment Code:     ${apartmentCode}`,
      `📧 Email:              ${email}`,
      `🔐 Temporary Password: ${tempPassword}`,
      ``,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `GETTING STARTED`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      ``,
      `1️⃣  Visit ${finalLoginUrl}`,
      `2️⃣  Use the credentials above to log in`,
      `3️⃣  Change your password immediately (security first!)`,
      `4️⃣  Add your building blocks and flats`,
      `5️⃣  Invite flat owners to complete their profiles`,
      `6️⃣  Start managing your community!`,
      ``,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      ``,
      `⚠️  Important: Change your temporary password after your first login.`,
      ``,
      `Have questions or need support? Reach out to us anytime at support@nivashub.in`,
      `or visit https://nivashub.in/help`,
      ``,
      `Welcome to the NivasHub community!`,
      ``,
      `Warm regards,`,
      `The NivasHub Team`,
      `https://nivashub.in`,
      ``,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    ].join("\n"),
  };
}

export function buildApartmentAdminWelcomeMail(args: {
  apartmentName: string;
  apartmentCode: string;
  adminName: string;
  email: string;
  tempPassword: string;
  loginUrl: string;
  position?: string;
}): MailMessage {
  const { apartmentName, apartmentCode, adminName, email, tempPassword, loginUrl, position } = args;
  const finalLoginUrl = loginUrl.includes("localhost") ? loginUrl : "https://nivashub.in/login";
  const positionLabel = position ? ` (${position})` : "";

  return {
    to: email,
    subject: `🛠️ NivasHub access granted — ${apartmentName}`,
    text: [
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      ``,
      `Hello ${adminName},`,
      ``,
      `You have been added as an apartment admin${positionLabel} for ${apartmentName}.`,
      `Your access is now ready on NivasHub, and you can manage apartment operations for your community.`,
      ``,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `YOUR LOGIN CREDENTIALS`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      ``,
      `📱 Login URL:          ${finalLoginUrl}`,
      `🏢 Apartment Code:     ${apartmentCode}`,
      `📧 Email:              ${email}`,
      `🔐 Temporary Password: ${tempPassword}`,
      ``,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `GETTING STARTED`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      ``,
      `1️⃣  Visit ${finalLoginUrl}`,
      `2️⃣  Log in using the credentials above`,
      `3️⃣  Change your password immediately`,
      `4️⃣  Start managing announcements, bookings, payments, and security`,
      ``,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      ``,
      `Questions? Contact your support team at support@nivashub.in`,
      ``,
      `Best regards,`,
      `The NivasHub Team`,
      `https://nivashub.in`,
      ``,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
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
  
  // Ensure we use https://nivashub.in/login if not in dev
  const finalLoginUrl = loginUrl.includes("localhost") ? loginUrl : "https://nivashub.in/login";
  
  const passwordSection = tempPassword
    ? [
        `🔐 Temporary Password: ${tempPassword}`,
        ``,
        `⚠️  Please change your password after your first login.`
      ]
    : [
        `Use your existing NivasHub account password.`,
        `If you've forgotten it, reset it from the login page.`
      ];
  
  return {
    to: email,
    subject: `🏠 Welcome to NivasHub — ${flatNumber}, ${apartmentName}`,
    text: [
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      ``,
      `Hello ${ownerName},`,
      ``,
      `Welcome to NivasHub! 🎉`,
      ``,
      `You've been registered as the owner of flat ${flatNumber} at ${apartmentName}.`,
      `Your community is now just a tap away!`,
      ``,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `WHAT YOU CAN NOW DO`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      ``,
      `📢 Receive announcements & notices from management`,
      `📅 Book amenities (gym, pool, courts, parking, etc.)`,
      `👥 Manage visitor passes for guests & contractors`,
      `📝 Update your flat details & resident information`,
      `💳 Track maintenance payments & dues`,
      `👫 Connect with neighbors & community members`,
      `🔔 Stay updated on society activities`,
      ``,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `YOUR LOGIN CREDENTIALS`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      ``,
      `📱 Login URL:          ${finalLoginUrl}`,
      `🏢 Apartment Code:     ${apartmentCode}`,
      `📧 Email:              ${email}`,
      ...passwordSection,
      ``,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `GET STARTED IN 3 STEPS`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      ``,
      `1️⃣  Visit ${finalLoginUrl}`,
      `2️⃣  Log in with your email and password`,
      `3️⃣  Complete your profile & explore your dashboard`,
      ``,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      ``,
      `Questions? Contact your apartment management or email us at support@nivashub.in`,
      ``,
      `Welcome to your community!`,
      ``,
      `Best regards,`,
      `The NivasHub Team`,
      `https://nivashub.in`,
      ``,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
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
  // delivering login details by email only, e.g. via Brevo).
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

interface TenantInviteArgs {
  apartmentName: string;
  apartmentCode: string;
  flatNumber: string;
  tenantName: string;
  ownerName: string;
  ownerEmail: string | null;
  ownerMobile: string | null;
  email: string | null;
  mobile: string | null;
  tempPassword: string | null;
  loginUrl: string;
}

export function buildFlatTenantWelcomeMail(args: TenantInviteArgs): MailMessage | null {
  if (!args.email) return null;
  const lines = [
    `Hello ${args.tenantName},`,
    "",
    `You have been added as a tenant for flat ${args.flatNumber} at ${args.apartmentName}.`,
    `Apartment code: ${args.apartmentCode}`,
    "",
    `Owner contact: ${args.ownerName}`,
    args.ownerEmail ? `Owner email: ${args.ownerEmail}` : undefined,
    args.ownerMobile ? `Owner phone: ${args.ownerMobile}` : undefined,
    "",
    `Login URL: ${args.loginUrl}`,
  ].filter(Boolean) as string[];

  if (args.tempPassword) {
    lines.push("", `Temporary password: ${args.tempPassword}`, "Please change your password after your first login.");
  } else {
    lines.push("", "Use your existing NivasHub password or reset it from the login page if needed.");
  }

  return {
    to: args.email,
    subject: `Tenant access to ${args.apartmentName} — flat ${args.flatNumber}`,
    text: lines.join("\n"),
  };
}

export function buildFlatTenantWelcomeWhatsApp(args: TenantInviteArgs): WhatsAppMessage | null {
  if (!args.mobile) return null;
  const lines = [
    `Hello ${args.tenantName},`,
    "",
    `You have been added as a tenant for flat ${args.flatNumber} at ${args.apartmentName}.`,
    `Apartment code: ${args.apartmentCode}`,
    "",
    `Owner contact: ${args.ownerName}`,
    args.ownerEmail ? `Owner email: ${args.ownerEmail}` : undefined,
    args.ownerMobile ? `Owner phone: ${args.ownerMobile}` : undefined,
    "",
    `Login URL: ${args.loginUrl}`,
  ].filter(Boolean) as string[];

  return {
    to: args.mobile,
    text: lines.join("\n"),
  };
}

export async function sendTenantInvite(args: TenantInviteArgs): Promise<{ email: boolean; whatsapp: boolean }> {
  const result = { email: false, whatsapp: false };
  const mail = buildFlatTenantWelcomeMail(args);
  if (mail) {
    try {
      await mailer.send(mail);
      result.email = true;
    } catch (err) {
      console.error("[mail] failed to send tenant invite", err);
    }
  }

  const disableWhatsApp = String(process.env.DISABLE_WHATSAPP ?? "false").toLowerCase() === "true";
  if (!disableWhatsApp) {
    const wa = buildFlatTenantWelcomeWhatsApp(args);
    if (wa) {
      try {
        await whatsapp.send(wa);
        result.whatsapp = true;
      } catch (err) {
        console.error("[whatsapp] failed to send tenant invite", err);
      }
    }
  } else if (!result.email) {
    console.log("[invite] DISABLE_WHATSAPP=true and no email available — no invite sent");
  }

  return result;
}

interface FlatAccountStatusNotificationArgs {
  apartmentName: string;
  apartmentCode: string;
  flatNumber: string;
  recipientName: string;
  email: string | null;
  mobile: string | null;
  active: boolean;
  loginUrl: string;
}

export function buildFlatAccountStatusMail(args: FlatAccountStatusNotificationArgs): MailMessage | null {
  if (!args.email) return null;

  const subject = args.active
    ? `Your NivasHub access for flat ${args.flatNumber} has been restored`
    : `Your NivasHub access for flat ${args.flatNumber} has been suspended`;

  const lines: string[] = [
    `Hello ${args.recipientName},`,
    "",
    `This is to let you know that access for flat ${args.flatNumber} at ${args.apartmentName} has been ${
      args.active ? "reactivated" : "suspended"
    } by your apartment administration.`,
    "",
  ];

  if (args.active) {
    lines.push(
      `Your account is now active again. You can log in using the same email and password at:`,
      `${args.loginUrl}`,
      "",
      "If you were previously logged out, please log in again.",
      "",
    );
  } else {
    lines.push(
      `Your account has been temporarily suspended until management reactivates it.`,
      "",
      `If you need help, please contact your apartment association.`,
      "",
    );
  }

  lines.push(
    `Apartment code: ${args.apartmentCode}`,
    "",
    `If you have questions, contact your apartment management or reply to this email.`,
    "",
    `— NivasHub`,
  );

  return {
    to: args.email,
    subject,
    text: lines.join("\n"),
  };
}

export function buildFlatAccountStatusWhatsApp(args: FlatAccountStatusNotificationArgs): WhatsAppMessage | null {
  if (!args.mobile) return null;

  const lines = [
    `Hello ${args.recipientName},`,
    "",
    `Flat ${args.flatNumber} at ${args.apartmentName} has been ${args.active ? "reactivated" : "suspended"}.`,
    "",
    args.active
      ? `Your account is active again. Log in here: ${args.loginUrl}`
      : `Your account is suspended until your apartment management reactivates it.`,
    "",
    `Apartment code: ${args.apartmentCode}`,
    "",
    `If you need help, contact your apartment association.`,
  ].filter(Boolean) as string[];

  return {
    to: args.mobile,
    text: lines.join("\n"),
  };
}

export async function sendFlatAccountStatusNotification(
  args: FlatAccountStatusNotificationArgs,
): Promise<{ email: boolean; whatsapp: boolean }> {
  const result = { email: false, whatsapp: false };
  const mail = buildFlatAccountStatusMail(args);
  if (mail) {
    try {
      await mailer.send(mail);
      result.email = true;
    } catch (err) {
      console.error("[mail] failed to send flat account status notification", err);
    }
  }

  const disableWhatsApp = String(process.env.DISABLE_WHATSAPP ?? "false").toLowerCase() === "true";
  if (!disableWhatsApp) {
    const wa = buildFlatAccountStatusWhatsApp(args);
    if (wa) {
      try {
        await whatsapp.send(wa);
        result.whatsapp = true;
      } catch (err) {
        console.error("[whatsapp] failed to send flat account status notification", err);
      }
    }
  } else if (!result.email) {
    console.log("[invite] DISABLE_WHATSAPP=true and no contact channel available — no status notification sent");
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
