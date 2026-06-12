import type { Request, Response, NextFunction } from "express";
import type { JwtPayload } from "./jwt.js";
import { prisma } from "./prisma.js";

/**
 * Checks whether the authenticated user holds a committee role for the
 * given apartment. Returns the committee position string (e.g. "president")
 * when they do, otherwise `null`.
 */
export async function getCommitteeApartmentAccess(
  auth: JwtPayload,
  targetApartmentId: string,
): Promise<string | null> {
  if (
    auth.committeeApartmentId === targetApartmentId
  ) {
    return auth.committeePosition ?? null;
  }
  return null;
}

/**
 * Middleware that works like `requireRole` but also grants access when the
 * user holds a committee position for the apartment identified by a route
 * parameter (default `:id`).
 *
 * Usage examples:
 *
 *   // Allow apartment_admin OR committee members (for param :id)
 *   requireCommitteeOrRole("apartmentId", "apartment_admin", "super_admin")
 *
 *   // Allow any of the listed roles
 *   requireCommitteeOrRole("apartmentId", "apartment_admin", "super_admin")
 */
export function requireCommitteeOrRole(
  apartmentParam: string,
  ...roles: JwtPayload["role"][]
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.auth) {
      res.status(401).json({ message: "Not authenticated" });
      return;
    }

    // Super admins can always pass through
    if (req.auth.role === "super_admin") {
      next();
      return;
    }

    // Check if the user's role is in the allowed list
    if (roles.includes(req.auth.role)) {
      // For apartment_admin, verify they're accessing their own apartment
      if (req.auth.role === "apartment_admin") {
        const targetId = req.params[apartmentParam];
        if (!targetId || req.auth.apartmentId === targetId) {
          next();
          return;
        }
        res.status(403).json({ message: "Forbidden — wrong apartment" });
        return;
      }
      next();
      return;
    }

    // For flat_admin with committee role, check committee access
    if (
      req.auth.role === "flat_admin" &&
      req.auth.committeePosition &&
      req.auth.committeeApartmentId
    ) {
      const targetId = req.params[apartmentParam];
      if (targetId && req.auth.committeeApartmentId === targetId) {
        next();
        return;
      }
    }

    res.status(403).json({ message: "Forbidden — insufficient role" });
  };
}

/**
 * Middleware that grants access if the user has apartment-level access
 * (either apartment_admin role OR a committee member for their apartment).
 * This does NOT check any route param — it simply verifies the user is
 * authorized to act within the apartment they're already associated with.
 *
 * Use this on routes where the scoping comes from the auth token itself
 * (e.g. complaint management within the user's own apartment), rather
 * than from a route parameter.
 */
export function requireApartmentAccess(
  ...roles: JwtPayload["role"][]
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.auth) {
      res.status(401).json({ message: "Not authenticated" });
      return;
    }

    // Super admins can always pass through
    if (req.auth.role === "super_admin") {
      next();
      return;
    }

    // Check if the user's role is in the allowed list
    if (roles.includes(req.auth.role)) {
      next();
      return;
    }

    // For flat_admin with committee role, grant apartment-level access
    if (
      req.auth.role === "flat_admin" &&
      req.auth.committeePosition &&
      req.auth.committeeApartmentId
    ) {
      next();
      return;
    }

    res.status(403).json({ message: "Forbidden — insufficient role" });
  };
}

/**
 * Returns true if the JwtPayload indicates the user has apartment-level
 * access (either direct apartment_admin or committee member).
 */
export function hasApartmentAccess(auth: JwtPayload | null | undefined): boolean {
  if (!auth) return false;
  if (auth.role === "apartment_admin") return true;
  if (auth.role === "super_admin") return true;
  if (auth.role === "flat_admin" && auth.committeePosition && auth.committeeApartmentId) {
    return true;
  }
  return false;
}
