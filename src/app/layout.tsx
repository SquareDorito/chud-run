import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000"
  ),
  title: "ChudRun — Scenic, Traffic-Free Running Routes",
  description:
    "Find traffic-free, park-filled running routes to a distance, neighborhood, or your favorite food spot — and share rich route previews anywhere.",
  openGraph: {
    title: "ChudRun — Scenic, Traffic-Free Running Routes",
    description:
      "Discover car-free paths, parks, waterfronts, and food-destination runs.",
    images: [{ url: "/api/og", width: 1200, height: 630 }],
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-[#F7F7FA] text-slate-900">
        {children}
      </body>
    </html>
  );
}
