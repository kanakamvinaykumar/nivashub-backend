import type { Request, Response, NextFunction } from "express";
import { verifyToken, type JwtPayload } from "../lib/jwt.js";
import { prisma } from "../lib/prisma.js";

declare global {
  namespace Express {
    interface Request {
      auth?: JwtPayload;
    }
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    res.status(401).json({ message: "Missing or invalid Authorization header" });
    return;
  }
  const token = header.slice("Bearer ".length);
  const payload = verifyToken(token);
  if (!payload) {
    res.status(401).json({ message: "Invalid or expired token" });
    return;
  }

  // Apartment-suspension gate. Super admin sessions are exempt — they need
  // to stay logged in to re-activate the apartment. For everyone else, if
  // their apartment is suspended we yank the session right here so the
  // frontend's 401 interceptor logs them out.
  if (payload.role !== "super_admin" && payload.apartmentId) {
    const apt = await prisma.apartment.findUnique({
      where: { id: payload.apartmentId },
      select: { status: true },
    });
    if (!apt || apt.status === "suspended") {
      res.status(401).json({
        message: "Your apartment has been deactivated. Please contact NivasHub.",
        suspended: true,
      });
      return;
    }
  }

  req.auth = payload;
  next();
}

export function requireRole(...roles: JwtPayload["role"][]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.auth) {
      res.status(401).json({ message: "Not authenticated" });
      return;
    }
    if (!roles.includes(req.auth.role)) {
      res.status(403).json({ message: "Forbidden — insufficient role" });
      return;
    }
    next();
  };
}

export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (header && header.startsWith("Bearer ")) {
    const payload = verifyToken(header.slice("Bearer ".length));
    if (payload) req.auth = payload;
  }
  next();
}
