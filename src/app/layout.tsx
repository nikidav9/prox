import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Gemini Dev Studio",
  description: "Multi-agent AI office powered by Google Gemini",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" style={{height:"100%"}}>
      <body style={{margin:0,padding:0,height:"100%"}}>{children}</body>
    </html>
  );
}
