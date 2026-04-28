import type { Metadata } from "next";
import { I18nProvider } from "./i18n";
import "./globals.css";

export const metadata: Metadata = {
  title: "1Doc",
  description: "A multilingual document index for public documentation sites.",
  icons: {
    icon: "/1doc-icon.png",
    apple: "/1doc-icon.png"
  }
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>
        <I18nProvider>{children}</I18nProvider>
      </body>
    </html>
  );
}
