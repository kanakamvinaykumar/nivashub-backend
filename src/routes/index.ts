import { Router } from "express";
import authRouter from "./auth.js";
import dataRouter from "./data.js";
import superAdminRouter from "./super-admin.js";
import complaintsRouter from "./complaints.js";
import paymentsRouter from "./payments.js";
import notificationsRouter from "./notifications.js";
import enquiriesRouter from "./enquiries.js";

const router = Router();

router.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

router.use("/auth", authRouter);
router.use("/super-admin", superAdminRouter);
router.use("/complaints", complaintsRouter);
router.use("/payments", paymentsRouter);
router.use("/enquiries", enquiriesRouter);
router.use("/", dataRouter);
router.use("/notifications", notificationsRouter);

export default router;
