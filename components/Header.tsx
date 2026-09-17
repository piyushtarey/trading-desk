"use client";

import Ticker from "./Ticker";
import WalletButton from "./WalletButton";

export default function Header() {
  return (
    <header className="border-b border-ink-700 bg-ink-900">
      <div className="flex items-center gap-4 px-4 py-2.5">
        <div className="min-w-0 flex-1 overflow-hidden">
          <Ticker />
        </div>
        <WalletButton />
      </div>
    </header>
  );
}
