import "dotenv/config";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const email = process.env.SUPER_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SUPER_ADMIN_PASSWORD;
  const name = process.env.SUPER_ADMIN_NAME?.trim() || "Super Admin";

  if (!email || !password) {
    console.error(
      "[seed:prod] SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD must be set in the environment.",
    );
    console.error(
      "[seed:prod] Example: SUPER_ADMIN_EMAIL=admin@nivashub.in SUPER_ADMIN_PASSWORD='...' npm run seed:prod",
    );
    process.exit(1);
  }

  if (password.length < 12) {
    console.error("[seed:prod] SUPER_ADMIN_PASSWORD must be at least 12 characters.");
    process.exit(1);
  }

  const existing = await prisma.user.findFirst({ where: { role: "super_admin" } });
  if (existing) {
    console.log(`[seed:prod] A super_admin already exists (${existing.email}). Nothing to do.`);
    return;
  }

  const passwordHash = await bcrypt.hash(password, 10);

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      name,
      role: "super_admin",
      apartmentId: null,
      apartmentName: null,
      flatId: null,
      flatNumber: null,
    },
  });

  console.log(`[seed:prod] Created super_admin ${user.email}.`);
  console.log("[seed:prod] Log in with:");
  console.log(`              apartment code: SUPER`);
  console.log(`              email:          ${user.email}`);
  console.log(`              password:       (the value of SUPER_ADMIN_PASSWORD)`);
}

main()
  .catch((err) => {
    console.error("[seed:prod] Failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
