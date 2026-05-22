import type { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import { isAllowedEmail } from "./config";
import { getRoleForEmail } from "./customer/config";
import { resolveAmNameForEmail } from "./customer/auth-mapping";

/**
 * Beacon umbrella NextAuth config.
 * Google OAuth + email-domain allowlist (zoca.com / zoca.ai).
 * Session strategy: JWT (no DB session table needed at the umbrella level).
 *
 * As agents migrate in, they inherit this same session. Per-agent role
 * checks (manager vs AM) happen inside each agent's route group.
 *
 * Role enrichment (Phase E-3.5): the jwt + session callbacks now also
 * populate `role` and `am_name` from lib/customer/* helpers when the email
 * resolves to one of the three customer-beacon roles (admin / manager / am).
 * This is ADDITIVE — emails outside those lists still get a session (so
 * performance/escalation/post-payment continue to work for any allowlisted
 * @zoca.com user), they just don't get `role` populated. lib/customer/
 * api-auth.ts then 403s such users on customer admin/manager routes,
 * which is the correct behavior.
 */
export const authOptions: NextAuthOptions = {
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID || "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
    }),
  ],
  session: { strategy: "jwt" },
  pages: {
    signIn: "/auth/signin",
  },
  callbacks: {
    async signIn({ user }) {
      // Block anyone outside the allowlisted domains.
      // NOT tightening to require a customer-beacon role here — that would
      // lock out Zoca team members who use other agents but aren't on v1's
      // strictlist. Per-route role gates in lib/customer/api-auth.ts handle
      // the finer-grained access control.
      return isAllowedEmail(user.email);
    },
    async jwt({ token, user }) {
      if (user) {
        token.email = user.email;
        token.name = user.name;
        token.picture = user.image;

        // Enrich with customer-beacon role + am_name when available. Soft
        // fail — if the email isn't in any customer-beacon list, we just
        // leave role/am_name unset and the session still issues.
        try {
          const email = (user.email || "").toLowerCase();
          const role = getRoleForEmail(email);
          if (role) {
            token.role = role;
            token.am_name =
              role === "am" ? await resolveAmNameForEmail(email) : null;
          }
        } catch (e) {
          // Never let role-enrichment errors block sign-in. The user can
          // still access agents that don't require a customer-beacon role.
          const msg = e instanceof Error ? e.message : String(e);
          console.warn(`[auth] jwt role enrichment failed: ${msg}`);
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.email = token.email as string | undefined;
        session.user.name = token.name as string | undefined;
        session.user.image = token.picture as string | undefined;

        // Propagate role + am_name from the JWT to the client session so
        // that useSession() reads + getServerSession() reads both expose
        // them. Customer routes read session.user.role for the admin/manager/
        // am gate; non-customer agents simply ignore these fields.
        if (token.role) {
          session.user.role = token.role as "admin" | "manager" | "am";
        }
        if (token.am_name !== undefined) {
          session.user.am_name = (token.am_name as string | null) ?? null;
        }
      }
      return session;
    },
  },
};
