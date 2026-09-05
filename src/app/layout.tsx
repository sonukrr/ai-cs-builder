import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Career Site Studio",
  description: "Build and change your career site by describing it.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
