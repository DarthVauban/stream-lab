import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "StreamLab — YouTube Stream MVP",
  description: "Локальний інструмент для завантаження відео та запуску RTMPS-трансляції на YouTube.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="uk">
      <body>{children}</body>
    </html>
  );
}

