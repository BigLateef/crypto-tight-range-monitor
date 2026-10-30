import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "Crypto Tight Range Monitor", description: "Tight-range alerts with a simulated paper portfolio. Not real money." };
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
