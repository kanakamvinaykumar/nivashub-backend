import "dotenv/config";
import bcrypt from "bcryptjs";
import { PrismaClient, type Prisma } from "@prisma/client";

const prisma = new PrismaClient();

const isoDaysAgo = (days: number) => new Date(Date.now() - days * 86400000);
const isoDaysFromNow = (days: number) => new Date(Date.now() + days * 86400000);

const APARTMENTS_SEED: Array<Omit<Prisma.ApartmentCreateInput, "createdAt" | "planExpiresAt"> & { planExpiresAt: Date; createdAt: Date }> = [
  {
    id: "apt-001",
    code: "GREEN-VALLEY",
    name: "Green Valley Heights",
    city: "Bengaluru",
    address: "Sarjapur Road, Bengaluru, KA 560035",
    registeredEmail: "admin@greenvalley.in",
    totalFlats: 248,
    occupiedFlats: 231,
    planTier: "Community",
    planCycle: "yearly",
    planExpiresAt: isoDaysFromNow(214),
    monthlyRevenue: 3499,
    status: "active",
    createdAt: isoDaysAgo(412),
  },
  {
    id: "apt-002",
    code: "SKYLINE",
    name: "Skyline Towers",
    city: "Hyderabad",
    address: "Gachibowli, Hyderabad, TG 500032",
    registeredEmail: "admin@skyline.in",
    totalFlats: 412,
    occupiedFlats: 389,
    planTier: "Enterprise",
    planCycle: "five_year",
    planExpiresAt: isoDaysFromNow(1640),
    monthlyRevenue: 7999,
    status: "active",
    createdAt: isoDaysAgo(890),
  },
  {
    id: "apt-003",
    code: "LOTUS",
    name: "Lotus Residency",
    city: "Pune",
    address: "Baner, Pune, MH 411045",
    registeredEmail: "admin@lotus.in",
    totalFlats: 96,
    occupiedFlats: 84,
    planTier: "Starter",
    planCycle: "monthly",
    planExpiresAt: isoDaysFromNow(18),
    monthlyRevenue: 1499,
    status: "active",
    createdAt: isoDaysAgo(120),
  },
  {
    id: "apt-004",
    code: "MARIGOLD",
    name: "Marigold Enclave",
    city: "Chennai",
    address: "OMR, Chennai, TN 600097",
    registeredEmail: "admin@marigold.in",
    totalFlats: 156,
    occupiedFlats: 142,
    planTier: "Community",
    planCycle: "yearly",
    planExpiresAt: isoDaysFromNow(98),
    monthlyRevenue: 3499,
    status: "active",
    createdAt: isoDaysAgo(540),
  },
  {
    id: "apt-005",
    code: "PALM-GROVE",
    name: "Palm Grove",
    city: "Mumbai",
    address: "Powai, Mumbai, MH 400076",
    registeredEmail: "admin@palmgrove.in",
    totalFlats: 320,
    occupiedFlats: 298,
    planTier: "Enterprise",
    planCycle: "yearly",
    planExpiresAt: isoDaysFromNow(132),
    monthlyRevenue: 7999,
    status: "active",
    createdAt: isoDaysAgo(720),
  },
  {
    id: "apt-006",
    code: "AMBER",
    name: "Amber Residency",
    city: "Gurugram",
    address: "Sector 56, Gurugram, HR 122011",
    registeredEmail: "admin@amber.in",
    totalFlats: 64,
    occupiedFlats: 41,
    planTier: "Starter",
    planCycle: "monthly",
    planExpiresAt: isoDaysFromNow(7),
    monthlyRevenue: 1499,
    status: "trial",
    createdAt: isoDaysAgo(22),
  },
  {
    id: "apt-007",
    code: "RIVER-OAKS",
    name: "River Oaks",
    city: "Kolkata",
    address: "New Town, Kolkata, WB 700156",
    registeredEmail: "admin@riveroaks.in",
    totalFlats: 180,
    occupiedFlats: 165,
    planTier: "Community",
    planCycle: "yearly",
    planExpiresAt: isoDaysFromNow(45),
    monthlyRevenue: 3499,
    status: "active",
    createdAt: isoDaysAgo(380),
  },
  {
    id: "apt-008",
    code: "CEDAR-PARK",
    name: "Cedar Park",
    city: "Ahmedabad",
    address: "Bopal, Ahmedabad, GJ 380058",
    registeredEmail: "admin@cedarpark.in",
    totalFlats: 88,
    occupiedFlats: 12,
    planTier: "Starter",
    planCycle: "monthly",
    planExpiresAt: isoDaysAgo(34),
    monthlyRevenue: 0,
    status: "suspended",
    createdAt: isoDaysAgo(180),
  },
];

const SEED_AMENITIES = [
  "Swimming Pool",
  "Gymnasium",
  "Clubhouse",
  "Children's Play Area",
  "Badminton Court",
  "Landscaped Gardens",
  "24x7 Security with CCTV",
  "Power Backup",
];

const SEED_RULES = [
  "Quiet hours: 10:00 PM to 7:00 AM. No loud music or parties beyond this window.",
  "Visitors must register at the gate and obtain a visitor pass before entering.",
  "Pet owners must keep pets on a leash in common areas and clean up after them.",
  "All construction or interior work must be approved by the association office in advance.",
  "Maintenance dues must be paid by the 10th of every month to avoid late fees.",
  "Garbage segregation (wet, dry, hazardous) is mandatory for every flat.",
  "Smoking is prohibited in lifts, lobbies, staircases and all common indoor areas.",
];

const SEED_COMMITTEE: Array<{ position: "president" | "secretary" | "treasurer" | "maintenance" | "cultural" | "security"; name: string; flatNumber: string; phone: string; email: string }> = [
  { position: "president", name: "Suresh Kumar", flatNumber: "A-201", phone: "+91 98450 11111", email: "president@society.in" },
  { position: "secretary", name: "Priya Sharma", flatNumber: "B-104", phone: "+91 98450 22222", email: "secretary@society.in" },
  { position: "treasurer", name: "Arjun Reddy", flatNumber: "C-307", phone: "+91 98450 33333", email: "treasurer@society.in" },
  { position: "maintenance", name: "Vikram Iyer", flatNumber: "A-405", phone: "+91 98450 44444", email: "maintenance@society.in" },
  { position: "cultural", name: "Anjali Menon", flatNumber: "D-201", phone: "+91 98450 55555", email: "cultural@society.in" },
  { position: "security", name: "Lakshmi Rao", flatNumber: "C-101", phone: "+91 98450 77777", email: "security@society.in" },
];

const indianFirstNames = [
  "Ramesh", "Priya", "Arjun", "Sneha", "Vikram", "Kavya", "Rohit", "Anjali",
  "Suresh", "Lakshmi", "Karthik", "Divya", "Anand", "Meera", "Rajesh", "Pooja",
  "Naveen", "Swati", "Mahesh", "Geeta",
];
const indianLastNames = [
  "Kumar", "Sharma", "Reddy", "Iyer", "Patel", "Rao", "Singh", "Nair",
  "Gupta", "Verma", "Menon", "Bose", "Pillai", "Khan", "Joshi",
];
const pick = <T,>(arr: T[], i: number): T => arr[i % arr.length]!;

const announcementTemplates = [
  {
    title: "Water tank cleaning — Tomorrow 10 AM to 2 PM",
    body: "Dear residents, the overhead water tanks will be cleaned tomorrow between 10:00 AM and 2:00 PM. Water supply will be interrupted during this window. Please store water in advance. Apologies for the inconvenience.",
    priority: "urgent" as const,
    pinned: true,
    authorName: "Suresh Kumar (Secretary)",
    commentsCount: 23,
    seenCount: 187,
  },
  {
    title: "Diwali decoration committee — volunteers needed",
    body: "We are forming the Diwali decoration committee. Anyone interested in helping, please reply or DM. We have a budget of ₹35,000. First meeting this Saturday at 6 PM in the clubhouse.",
    priority: "normal" as const,
    pinned: true,
    authorName: "Priya Sharma (Cultural Secretary)",
    commentsCount: 41,
    seenCount: 152,
  },
  {
    title: "Generator maintenance — Sunday 6 AM to 9 AM",
    body: "Routine quarterly generator maintenance scheduled for Sunday morning. There may be brief power blips during testing.",
    priority: "normal" as const,
    pinned: false,
    authorName: "Vikram Reddy (Maintenance Lead)",
    commentsCount: 5,
    seenCount: 98,
  },
  {
    title: "New gym equipment installed",
    body: "Two new treadmills and a multi-station weight machine are now in the gym. Please follow the gym etiquette posted at the entrance.",
    priority: "low" as const,
    pinned: false,
    authorName: "Anjali Iyer (Sports Secretary)",
    commentsCount: 12,
    seenCount: 76,
  },
  {
    title: "Festival of lights — Society Diwali Mela",
    body: "Save the date! Our annual Diwali Mela is on the 28th. Stalls, food, and a small cultural programme by the children. Sign up to host a stall.",
    priority: "normal" as const,
    pinned: false,
    authorName: "Cultural Committee",
    commentsCount: 19,
    seenCount: 134,
  },
  {
    title: "Visitor parking discipline — please cooperate",
    body: "Several complaints received about visitors parking in resident slots. Please brief your guests to use the visitor parking only.",
    priority: "normal" as const,
    pinned: false,
    authorName: "Security Office",
    commentsCount: 8,
    seenCount: 121,
  },
];

const courts = ["Badminton Court A", "Badminton Court B", "Tennis Court", "Squash Court", "Clubhouse"];

const listingTemplates = [
  {
    title: "Samsung 7kg Front-Load Washing Machine",
    description: "2 years old, works perfectly. Selling because of relocation. Original bill available.",
    price: 8000,
    category: "Electronics",
    condition: "Good",
    tags: ["washing-machine", "samsung", "electronics"],
  },
  {
    title: "Home-cooked Andhra meals — daily tiffin service",
    description: "Authentic Andhra-style lunch & dinner tiffins. Veg ₹120, Non-veg ₹160. Delivered to flat.",
    price: 120,
    category: "Food",
    condition: "New",
    tags: ["tiffin", "andhra", "home-food"],
  },
  {
    title: "IKEA Study Desk + Chair",
    description: "1 year old, like new. Pickup from B-302.",
    price: 5500,
    category: "Furniture",
    condition: "Excellent",
    tags: ["furniture", "ikea", "desk"],
  },
  {
    title: "Maths tuition for Classes 8–10",
    description: "ICSE/CBSE board specialist. M.Sc. (Maths). Small batches. Contact for fees.",
    price: 0,
    category: "Services",
    condition: "New",
    tags: ["tuition", "maths", "education"],
  },
  {
    title: "Bajaj Pulsar 150 — single owner",
    description: "2019 model, 18,000 km, all papers updated.",
    price: 62000,
    category: "Vehicles",
    condition: "Good",
    tags: ["bike", "bajaj", "vehicle"],
  },
  {
    title: "Yoga classes — every morning, 6 AM",
    description: "Hatha & Iyengar yoga in the clubhouse. ₹2000/month.",
    price: 2000,
    category: "Services",
    condition: "New",
    tags: ["yoga", "fitness"],
  },
];

async function main() {
  console.log("[seed] Clearing existing data...");
  await prisma.visitorPass.deleteMany();
  await prisma.listing.deleteMany();
  await prisma.booking.deleteMany();
  await prisma.announcement.deleteMany();
  await prisma.user.deleteMany();
  await prisma.resident.deleteMany();
  await prisma.flat.deleteMany();
  await prisma.block.deleteMany();
  await prisma.committeeMember.deleteMany();
  await prisma.societyRule.deleteMany();
  await prisma.amenity.deleteMany();
  await prisma.apartment.deleteMany();

  console.log("[seed] Creating apartments...");
  for (const apt of APARTMENTS_SEED) {
    await prisma.apartment.create({ data: apt });
  }

  console.log("[seed] Creating amenities, rules and committee...");
  for (const apt of APARTMENTS_SEED) {
    for (const name of SEED_AMENITIES) {
      await prisma.amenity.create({ data: { apartmentId: apt.id, name } });
    }
    for (const text of SEED_RULES) {
      await prisma.societyRule.create({ data: { apartmentId: apt.id, text } });
    }
    for (const m of SEED_COMMITTEE) {
      await prisma.committeeMember.create({ data: { apartmentId: apt.id, ...m } });
    }
  }

  console.log("[seed] Creating blocks, flats and residents...");
  for (const apt of APARTMENTS_SEED) {
    const blockNames = ["A", "B", "C", "D"];
    const blockMap = new Map<string, string>();
    for (const name of blockNames) {
      const created = await prisma.block.create({ data: { apartmentId: apt.id, name } });
      blockMap.set(name, created.id);
    }

    const sampleSize = Math.min(apt.totalFlats, 32);
    for (let i = 0; i < sampleSize; i++) {
      const block = blockNames[i % blockNames.length]!;
      const numStr = `${block}-${100 + Math.floor(i / blockNames.length) * 100 + ((i % 8) + 1)}`;
      const owner = `${pick(indianFirstNames, i + apt.totalFlats)} ${pick(indianLastNames, i)}`;
      const residentCount = ((i * 3) % 5) + 1;
      const status = i % 11 === 0 ? "vacant" : i % 4 === 0 ? "rented" : "occupied";
      const flatId = `${apt.id}-flat-${i + 1}`;
      const finalResidentCount = status === "vacant" ? 0 : residentCount;
      const occupantType = status === "rented" ? "tenant" : "resident";
      const tenantName = status === "rented" ? `${pick(indianFirstNames, i + 5)} ${pick(indianLastNames, i + 3)}` : null;

      await prisma.flat.create({
        data: {
          id: flatId,
          apartmentId: apt.id,
          blockId: blockMap.get(block)!,
          block,
          number: numStr,
          ownerName: owner,
          occupantType,
          tenantName,
          residentCount: finalResidentCount,
          status,
          pendingDuesInr: i % 6 === 0 ? 0 : Math.round(((i * 1234) % 18000) / 100) * 100,
        },
      });

      if (status !== "vacant") {
        for (let r = 0; r < finalResidentCount; r++) {
          await prisma.resident.create({
            data: {
              id: `${flatId}-r-${r + 1}`,
              flatId,
              name: `${pick(indianFirstNames, i * 3 + r)} ${pick(indianLastNames, i + r * 2)}`,
              relation: r === 0 ? "Owner" : r === 1 ? "Spouse" : r === 2 ? "Child" : "Parent",
              phone: `+91 9${String((i + 1) * (r + 7) * 113).padStart(9, "0").slice(0, 9)}`,
            },
          });
        }
      }
    }
  }

  console.log("[seed] Creating announcements...");
  for (const apt of APARTMENTS_SEED) {
    for (let idx = 0; idx < announcementTemplates.length; idx++) {
      const tmpl = announcementTemplates[idx]!;
      await prisma.announcement.create({
        data: {
          id: `${apt.id}-ann-${idx + 1}`,
          apartmentId: apt.id,
          ...tmpl,
          createdAt: isoDaysAgo(idx + 1),
        },
      });
    }
  }

  console.log("[seed] Creating bookings...");
  for (const apt of APARTMENTS_SEED) {
    const aptFlats = await prisma.flat.findMany({ where: { apartmentId: apt.id } });
    for (let i = 0; i < 12; i++) {
      const flat = aptFlats[i % aptFlats.length]!;
      const dayOffset = (i % 7) - 2;
      const startHour = 6 + (i % 12);
      await prisma.booking.create({
        data: {
          id: `${apt.id}-bk-${i + 1}`,
          apartmentId: apt.id,
          flatNumber: flat.number,
          residentName: flat.ownerName,
          court: pick(courts, i),
          date: new Date(Date.now() + dayOffset * 86400000).toISOString().slice(0, 10),
          startTime: `${String(startHour).padStart(2, "0")}:00`,
          endTime: `${String(startHour + 1).padStart(2, "0")}:00`,
          status: dayOffset < 0 ? "completed" : i % 9 === 0 ? "cancelled" : "confirmed",
        },
      });
    }
  }

  console.log("[seed] Creating listings...");
  for (const apt of APARTMENTS_SEED) {
    const aptFlats = await prisma.flat.findMany({ where: { apartmentId: apt.id } });
    for (let idx = 0; idx < listingTemplates.length; idx++) {
      const tmpl = listingTemplates[idx]!;
      const flat = aptFlats[idx % aptFlats.length]!;
      await prisma.listing.create({
        data: {
          id: `${apt.id}-list-${idx + 1}`,
          apartmentId: apt.id,
          ...tmpl,
          sellerName: flat.ownerName,
          sellerFlat: flat.number,
          status: "active",
          createdAt: isoDaysAgo(idx + 1),
        },
      });
    }
  }

  console.log("[seed] Creating visitor passes...");
  for (const apt of APARTMENTS_SEED) {
    const aptFlats = await prisma.flat.findMany({ where: { apartmentId: apt.id } });
    for (let i = 0; i < 10; i++) {
      const flat = aptFlats[i % aptFlats.length]!;
      const type = i % 3 === 0 ? "delivery" : i % 3 === 1 ? "guest" : "contractor";
      const status = i % 7 === 0 ? "expired" : i % 5 === 0 ? "used" : "active";
      await prisma.visitorPass.create({
        data: {
          id: `${apt.id}-vp-${i + 1}`,
          apartmentId: apt.id,
          flatId: flat.id,
          flatNumber: flat.number,
          guestName:
            type === "delivery"
              ? `${pick(["Swiggy", "Zomato", "Amazon", "Flipkart", "BlueDart"], i)} Delivery`
              : type === "contractor"
                ? `${pick(["Plumber", "Electrician", "Carpenter", "AC Tech"], i)} Visit`
                : `${pick(indianFirstNames, i)} ${pick(indianLastNames, i + 4)}`,
          type,
          code: String((i * 137 + apt.id.length * 31) % 1000000).padStart(6, "0"),
          status,
          createdAt: isoDaysAgo(i),
          expiresAt: isoDaysFromNow(2),
        },
      });
    }
  }

  console.log("[seed] Creating users (password: demo1234)...");
  const passwordHash = await bcrypt.hash("demo1234", 10);

  await prisma.user.create({
    data: {
      id: "u-super",
      email: "super@nivashub.in",
      passwordHash,
      name: "Aditya Bhatia",
      role: "super_admin",
      apartmentId: null,
      apartmentName: null,
      flatId: null,
      flatNumber: null,
    },
  });

  await prisma.user.create({
    data: {
      id: "u-apt-1",
      email: "admin@greenvalley.in",
      passwordHash,
      name: "Suresh Kumar",
      role: "apartment_admin",
      apartmentId: "apt-001",
      apartmentName: "Green Valley Heights",
      flatId: null,
      flatNumber: null,
    },
  });

  const firstFlat = await prisma.flat.findFirst({ where: { apartmentId: "apt-001" } });
  await prisma.user.create({
    data: {
      id: "u-flat-1",
      email: "rohit@flat.in",
      passwordHash,
      name: "Rohit Reddy",
      role: "flat_admin",
      apartmentId: "apt-001",
      apartmentName: "Green Valley Heights",
      flatId: firstFlat?.id ?? null,
      flatNumber: firstFlat?.number ?? null,
    },
  });

  console.log("[seed] Done.");
  console.log("\nDemo accounts (all password: demo1234):");
  console.log("  • super@nivashub.in        / code SUPER          (super_admin)");
  console.log("  • admin@greenvalley.in        / code GREEN-VALLEY   (apartment_admin)");
  console.log("  • rohit@flat.in               / code GREEN-VALLEY   (flat_admin)");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
