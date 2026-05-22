// NextAuth module augmentation — ported from v1's customer beacon (Phase 33.B).
//
// Adds `role` and `am_name` to both the Session.user object (consumed by
// useSession() on the client + getServerSession() on the server in customer
// routes) and the JWT payload (consumed by withAuth middleware to gate
// admin/manager routes).
//
// Beacon's other agents (performance, escalation, post-payment) don't read
// these fields today, so this augmentation is additive — it doesn't break
// existing code. lib/customer/api-auth.ts is the primary consumer:
//   const session = await getServerSession(authOptions);
//   session.user.role; session.user.am_name;
//
// Role union: "admin" | "manager" | "am". The full strictlist of which
// emails fall under which role lives in lib/customer/auth-mapping.ts;
// beacon's root lib/auth.ts populates these fields at JWT-creation time.

import "next-auth";
import "next-auth/jwt";

declare module "next-auth" {
  interface Session {
    user: {
      name?: string | null;
      email?: string | null;
      image?: string | null;
      role: "admin" | "manager" | "am";
      am_name: string | null;
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    role?: "admin" | "manager" | "am";
    am_name?: string | null;
  }
}
