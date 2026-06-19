import type { MailMessage } from "./mailer.js";

export function buildSelfRegistrationMail(args: {
  name: string;
  email: string;
  apartmentName: string;
  apartmentCode: string;
  tempPassword: string;
  loginUrl: string;
}): MailMessage {
  const { name, email, apartmentName, apartmentCode, tempPassword, loginUrl } = args;
  const finalLoginUrl = loginUrl.includes("localhost") ? loginUrl : "https://nivashub.in/login";

  return {
    to: email,
    subject: `🎉 Welcome to NivasHub — ${apartmentName} is ready!`,
    text: [
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      ``,
      `Hello ${name},`,
      ``,
      `Your society "${apartmentName}" has been registered on NivasHub!`,
      `You are now the apartment admin, and you can start managing your community right away.`,
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
      `NEXT STEPS`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      ``,
      `1️⃣  Visit ${finalLoginUrl}`,
      `2️⃣  Enter your apartment code: ${apartmentCode}`,
      `3️⃣  Log in with the credentials above`,
      `4️⃣  Change your password immediately`,
      `5️⃣  Add blocks, flats, and invite residents`,
      ``,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      ``,
      `Your 30-day free trial has started. No payment needed — explore all features!`,
      ``,
      `Have questions? Email us at support@nivashub.in`,
      ``,
      `Welcome aboard!`,
      `The NivasHub Team`,
      `https://nivashub.in`,
      ``,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    ].join("\n"),
  };
}
