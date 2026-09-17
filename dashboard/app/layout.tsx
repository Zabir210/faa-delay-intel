import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "FAA Delay Intelligence",
  description:
    "Live US airport disruption tracking. Polling the FAA NAS Status feed " +
    "every 5 minutes since 2026-09-16 to build a historical record that " +
    "does not otherwise exist.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
