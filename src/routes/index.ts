import { Router } from "express";
import authRouter from "./auth.js";
import dataRouter from "./data.js";
import superAdminRouter from "./super-admin.js";
import complaintsRouter from "./complaints.js";
import paymentsRouter from "./payments.js";

const router = Router();

router.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

router.use("/auth", authRouter);
router.use("/super-admin", superAdminRouter);
router.use("/complaints", complaintsRouter);
router.use("/payments", paymentsRouter);
router.use("/", dataRouter);

export default router;
