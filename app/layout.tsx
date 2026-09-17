import type { Metadata } from "next";
import "./globals.css";
import { DeskProvider } from "@/lib/store";
import { WalletProvider } from "@/lib/wallet";
import Sidebar from "@/components/Sidebar";
import Header from "@/components/Header";

export const metadata: Metadata = {
  title: "Trading Desk — 3-Agent Sync",
  description: "Mockup: Trade Scout → Trade Analyst → Trade Executor",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <WalletProvider>
          <DeskProvider>
            <div className="flex h-screen overflow-hidden">
              <Sidebar />
              <div className="flex min-w-0 flex-1 flex-col">
                <Header />
                <main className="min-h-0 flex-1 overflow-y-auto bg-ink-950">{children}</main>
              </div>
            </div>
          </DeskProvider>
        </WalletProvider>
      </body>
    </html>
  );
}
