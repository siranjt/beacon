import { type NextAuthOptions } from "next-auth";
import Google from "next-auth/providers/google";
import { getRoleForEmail } from "./config";
import { resolveAmNameForEmail } from "./auth-mapping";
import { logActivity } from "./activity";

// Phase 33.A — NextAuth v4 + Google OAuth.
// JWT session strategy (no database adapter). Sessions live in a signed
// JWT cookie; the only server-side state is the in-memory BaseSheet cache
// in lib/auth-mapping.ts.
//
// Domain restriction (first-line filter): only @zoca.ai and @zoca.com emails
// can sign in. Anything else fails the signIn callback immediately.
//
// Phase 33.B — strict allowlist mode (three roles): admin / manager / am.
// In addition to the domain check, the email MUST appear in one of the three
// allowlists in lib/config.ts (ADMIN_EMAILS, MANAGER_EMAILS, AM_EMAILS).
// `getRoleForEmail(email)` returns null for unlisted emails, which is the
// rejection signal — the signIn callback bounces those users to
// /auth/signin?error=AccessDenied.
//
// Phase 33.A.2 — authOptions moved here (from app/api/auth/[...nextauth]/route.ts)
// because Next.js 14 App Router route handlers can only export GET/POST/etc.
// Exporting `authOptions` from the route file triggers a TypeScript error:
// "authOptions is not a valid Route export field." This file is import-only.
//
// Phase 33.B (usage tracking) — events.signIn writes one row per successful
// login to am_activity_log so we can answer "who's actually using this".

const ALLOWED_DOMAINS = ["zoca.ai", "zoca.com"];

export const authOptions: NextAuthOptions = {
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID || "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
      // Force account selection on sign in — avoids "logged in to the wrong
      // Google account" complaints from AMs who have multiple workspaces.
      authorization: {
        params: {
          prompt: "select_account",
        },
      },
    }),
  ],
  session: {
    strategy: "jwt",
    maxAge: 30 * 24 * 60 * 60, // 30 days
  },
  pages: {
    signIn: "/auth/signin",
    error:  "/auth/signin",
  },
  callbacks: {
    async signIn({ user }) {
      try {
        const email = (user.email || "").toLowerCase();
        if (!email) {
          console.warn("[auth] signIn rejected: no email on Google profile");
          return false;
        }
        const domain = email.split("@")[1] || "";
        if (!ALLOWED_DOMAINS.includes(domain)) {
          console.warn(
            `[auth] signIn rejected: domain=${domain} not in ${ALLOWED_DOMAINS.join(",")}`,
          );
          return false;
        }
        // Phase 33.B — strict allowlist: email must resolve to one of the
        // three roles. Unlisted emails are rejected here even if the domain
        // check passed.
        const role = getRoleForEmail(email);
        if (!role) {
          console.warn(
            `[auth] signIn rejected: email=${email} is not in any allowlist (admin/manager/am)`,
          );
          return false;
        }
        return true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[auth] signIn callback threw: ${msg}`);
        return false;
      }
    },
    async jwt({ token, user }) {
      try {
        // `user` is only present on the first call after sign-in. Subsequent
        // calls just refresh the token — keep what's already there.
        if (user) {
          const email = (user.email || "").toLowerCase();
          const role = getRoleForEmail(email);
          if (!role) {
            // Defensive: signIn callback should have rejected, but if we ended
            // up here without a role, treat the token as invalid (return as-is
            // and let route-level guards 401/403 the request).
            console.warn(
              `[auth] jwt callback: email=${email} resolved to null role; token left unenriched`,
            );
            return token;
          }
          token.email = email;
          token.role = role;
          // Admins + managers don't get locked to a book, so am_name is null
          // for them. Only role="am" carries an am_name (which itself may be
          // null if BaseSheet doesn't map them — the dashboard shows the
          // "unmapped" empty state for that case).
          token.am_name =
            role === "am" ? await resolveAmNameForEmail(email) : null;
        }
        return token;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[auth] jwt callback threw: ${msg}`);
        // Return token as-is so the session still works (just without enriched fields)
        return token;
      }
    },
    async session({ session, token }) {
      try {
        if (session.user) {
          session.user.role =
            (token.role as "admin" | "manager" | "am") || "am";
          session.user.am_name = (token.am_name as string | null) ?? null;
        }
        return session;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[auth] session callback threw: ${msg}`);
        return session;
      }
    },
  },
  // Phase 33.B (usage tracking) — fires once per successful sign-in.
  // NextAuth runs this AFTER the signIn callback returns true, so by here
  // the email is guaranteed to be on the allowlist + have a resolved role.
  events: {
    signIn: async ({ user }) => {
      try {
        const email = (user.email || "").toLowerCase();
        if (!email) return;
        const role = getRoleForEmail(email);
        if (!role) return;  // shouldn't happen — signIn already rejected unlisted emails
        const am_name = role === "am" ? await resolveAmNameForEmail(email) : null;
        void logActivity({
          email,
          role,
          am_name,
          event_name: "sign_in",
          surface: "auth",
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[auth] events.signIn logActivity threw: ${msg}`);
      }
    },
  },
};
