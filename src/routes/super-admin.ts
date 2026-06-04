import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { generateActivity, generateRevenueTrend } from "../lib/activity.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();

router.use(requireAuth, requireRole("super_admin"));

router.get("/summary", async (_req, res) => {
  const [apartments, flats] = await Promise.all([
    prisma.apartment.findMany(),
    prisma.flat.findMany(),
  ]);
  const totalFlats = flats.length;
  const totalResidents = flats.reduce((s, f) => s + f.residentCount, 0);
  const active = apartments.filter((a) => a.status === "active");
  const trial = apartments.filter((a) => a.status === "trial");
  const suspended = apartments.filter((a) => a.status === "suspended");
  const mrr = active.reduce((s, a) => s + a.monthlyRevenue, 0);
  const planBreakdown = ["Starter", "Community", "Enterprise"].map((tier) => ({
    tier,
    count: apartments.filter((a) => a.planTier === tier).length,
  }));
  res.json({
    totalApartments: apartments.length,
    totalFlats,
    totalResidents,
    activeSubscriptions: active.length,
    monthlyRecurringRevenue: mrr,
    trialApartments: trial.length,
    suspendedApartments: suspended.length,
    churnRate: 2.4,
    planBreakdown,
  });
});

router.get("/recent-activity", async (_req, res) => {
  res.json(await generateActivity());
});

router.get("/revenue-trend", (_req, res) => {
  res.json(generateRevenueTrend());
});

export default router;
