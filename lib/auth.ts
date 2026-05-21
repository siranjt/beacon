import type { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import { isAllowedEmail } from "./config";

/**
 * Beacon umbrella NextAuth config.
 * Google OAuth + email-domain allowlist (zoca.com / zoca.ai).
 * Session strategy: JWT (no DB session table needed at the umbrella level).
 *
 * As agents migrate in, they inherit this same session. Per-agent role
 * checks (manager vs AM) happen inside each agent's route group.
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
      return isAllowedEmail(user.email);
    },
    async jwt({ token, user }) {
      if (user) {
        token.email = user.email;
        token.name = user.name;
        token.picture = user.image;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.email = token.email as string | undefined;
        session.user.name = token.name as string | undefined;
        session.user.image = token.picture as string | undefined;
      }
      return session;
    },
  },
};
