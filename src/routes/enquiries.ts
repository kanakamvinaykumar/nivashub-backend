import { Router, type Request, type Response } from "express";
import { prisma } from "../lib/prisma.js";
import { mailer } from "../lib/mailer.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();

/**
 * POST /api/enquiries — public endpoint for the Contact Us form
 * Body: { name, email, phone, city, associationName?, message? }
 */
router.post("/", async (req: Request, res: Response) => {
  try {
    const { name, email, phone, city, associationName, message } = req.body;

    // Validate required fields
    if (!name?.trim() || !email?.trim() || !phone?.trim() || !city?.trim()) {
      return res.status(400).json({
        message: "Name, email, phone and city are required.",
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.trim())) {
      return res.status(400).json({ message: "Invalid email address." });
    }

    // Validate phone (Indian mobile: 10 digits or international format)
    const phoneDigits = phone.replace(/\D/g, "");
    if (phoneDigits.length < 10) {
      return res.status(400).json({ message: "Invalid phone number." });
    }

    // Save to database
    const enquiry = await prisma.enquiry.create({
      data: {
        name: name.trim(),
        email: email.trim().toLowerCase(),
        phone: phoneDigits,
        city: city.trim(),
        associationName: associationName?.trim() || null,
        message: message?.trim() || null,
      },
    });

    // Send thank-you email to the enquirer
    try {
      await mailer.send({
        to: enquiry.email,
        subject: "Thank you for reaching out to NivasHub!",
        text: [
          `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
          ``,
          `Hello ${enquiry.name},`,
          ``,
          `Thank you for getting in touch with NivasHub!`,
          ``,
          `We have received your enquiry and our team will get back to you shortly.`,
          ``,
          `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
          `YOUR ENQUIRY SUMMARY`,
          `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
          ``,
          `Name:              ${enquiry.name}`,
          `Email:             ${enquiry.email}`,
          `Phone:             ${enquiry.phone}`,
          `City:              ${enquiry.city}`,
          `Association Name:  ${enquiry.associationName ?? "—"}`,
          `Message:           ${enquiry.message ?? "—"}`,
          ``,
          `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
          ``,
          `We look forward to helping you manage your community better!`,
          ``,
          `Warm regards,`,
          `The NivasHub Team`,
          `https://nivashub.in`,
          ``,
          `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        ].join("\n"),
      });
    } catch (emailErr) {
      // Log but don't fail the request — the enquiry is saved
      console.error("[enquiries] Failed to send thank-you email:", emailErr);
    }

    // Send email notification to super admin
    const adminEmail = "kanakamvinaykumar82@gmail.com";
    try {
      await mailer.send({
        to: adminEmail,
        subject: `New NivasHub enquiry from ${enquiry.name} — ${enquiry.city}`,
        text: [
          `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
          `NEW ENQUIRY`,
          `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
          ``,
          `Name:              ${enquiry.name}`,
          `Email:             ${enquiry.email}`,
          `Phone:             ${enquiry.phone}`,
          `City:              ${enquiry.city}`,
          `Association Name:  ${enquiry.associationName ?? "—"}`,
          `Message:           ${enquiry.message ?? "—"}`,
          ``,
          `Submitted at:      ${enquiry.createdAt.toISOString()}`,
          `Enquiry ID:        ${enquiry.id}`,
          ``,
          `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        ].join("\n"),
      });
    } catch (emailErr) {
      // Log but don't fail the request — the enquiry is saved
      console.error("[enquiries] Failed to send email notification:", emailErr);
    }

    return res.status(201).json({
      message:
        "Thank you for your enquiry! We will get back to you shortly.",
    });
  } catch (err) {
    console.error("[enquiries] POST / error:", err);
    return res.status(500).json({ message: "Internal server error." });
  }
});

/**
 * GET /api/enquiries — super admin only, returns list of all enquiries
 */
router.get("/", requireAuth, requireRole("super_admin"), async (_req: Request, res: Response) => {
  try {
    const enquiries = await prisma.enquiry.findMany({
      orderBy: { createdAt: "desc" },
    });

    return res.json(enquiries);
  } catch (err) {
    console.error("[enquiries] GET / error:", err);
    return res.status(500).json({ message: "Internal server error." });
  }
});

export default router;
