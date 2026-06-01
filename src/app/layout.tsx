import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Dev Office",
  description: "15 AI-агентов в пиксельном офисе",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" style={{height:"100%"}}>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#7c3aed" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <link rel="manifest" href="/manifest.json" />
        <link rel="apple-touch-icon" href="/icon-192.png" />
      </head>
      <body style={{margin:0,padding:0,height:"100%"}}>{children}</body>
    </html>
  );
}
