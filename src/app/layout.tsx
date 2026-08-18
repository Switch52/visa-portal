import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

import { Toaster } from "@/components/ui/sonner";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Passport & Booking Portal",
  description: "Passport intake, handoff and balances.",
  // This app holds passport numbers, names and dates of birth. Keep it out of indexes.
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      {/* Clerk's provider goes inside <body>, not around <html> — wrapping the document
          element is the documented mistake and breaks hydration.

          The key is passed as a prop, read from a plain server-side variable rather than
          a NEXT_PUBLIC_ one. NEXT_PUBLIC_ values are inlined into the bundle at build
          time, which would bake this environment's key into the image and undo the point
          of building once and promoting the same image. As a prop it is resolved per
          request on the server and handed across to the client. */}
      <body className="min-h-full flex flex-col bg-muted/30">
        <ClerkProvider publishableKey={process.env.CLERK_PUBLISHABLE_KEY}>
          {children}
          <Toaster />
        </ClerkProvider>
      </body>
    </html>
  );
}
