import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { signToken } from "../lib/jwt.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

const LoginSchema = z.object({
  apartmentCode: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(1),
});

router.post("/login", async (req, res) => {
  const parsed = LoginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const { apartmentCode, email, password } = parsed.data;
  const codeUpper = apartmentCode.trim().toUpperCase();

  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user) {
    res.status(401).json({ message: "Invalid email or password" });
    return;
  }
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    res.status(401).json({ message: "Invalid email or password" });
    return;
  }

  if (user.role === "super_admin") {
    if (codeUpper !== "SUPER" && codeUpper !== "NIVASHUB") {
      res.status(401).json({ message: "Super admin must use code SUPER or NIVASHUB" });
      return;
    }
  } else {
    const apartment = await prisma.apartment.findUnique({ where: { code: codeUpper } });
    if (!apartment || apartment.id !== user.apartmentId) {
      res.status(401).json({ message: "Apartment code does not match user" });
      return;
    }
    // A super admin can suspend an apartment to lock both its admin and
    // every flat owner out of the platform immediately.
    if (apartment.status === "suspended") {
      res.status(403).json({
        message:
          "This apartment has been deactivated by NivasHub. Please contact your administrator.",
        suspended: true,
      });
      return;
    }
  }

  const token = signToken({
    userId: user.id,
    role: user.role,
    apartmentId: user.apartmentId,
    flatId: user.flatId,
  });

  res.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      apartmentId: user.apartmentId,
      apartmentName: user.apartmentName,
      flatId: user.flatId,
      flatNumber: user.flatNumber,
    },
  });
});

router.post("/logout", (_req, res) => {
  // JWT is stateless — client just discards token. Endpoint kept for API parity.
  res.json({ ok: true });
});

router.get("/me", requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.auth!.userId } });
  if (!user) {
    res.status(401).json({ message: "Not authenticated" });
    return;
  }
  res.json({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    apartmentId: user.apartmentId,
    apartmentName: user.apartmentName,
    flatId: user.flatId,
    flatNumber: user.flatNumber,
  });
});

export default router;
