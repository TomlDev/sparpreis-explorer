"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarDays, LogOut, Search, Settings, TrainFront } from "lucide-react";
import { Button, buttonClass } from "@/components/ui";
import { ThemeToggle } from "@/components/ThemeToggle";
import { TodayBanner } from "@/components/trips/TodayBanner";

export function AppHeader({ center }: { center?: ReactNode }) {
  const router = useRouter();
  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur">
      <div className="container flex h-14 items-center gap-2">
        <Link href="/" className="flex shrink-0 items-center gap-2 font-semibold">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/15 text-primary">
            <TrainFront className="h-5 w-5" />
          </span>
          <span className="hidden lg:inline">Sparpreis-Explorer</span>
        </Link>
        {/* Phones: the page's compact bar gets its own row below — it doesn't fit next to the icons. */}
        <div className={center ? "flex-1 sm:hidden" : "flex-1"} />
        {center && <div className="hidden min-w-0 flex-1 sm:block">{center}</div>}
        <nav className="flex shrink-0 items-center gap-0.5 sm:gap-1 [&>*]:h-9 [&>*]:w-9 sm:[&>*]:h-10 sm:[&>*]:w-10">
          <Link href="/reisen" className={buttonClass("ghost", "icon")} aria-label="Reisen" title="Meine Reisen">
            <CalendarDays className="h-5 w-5" />
          </Link>
          <Link href="/" className={buttonClass("ghost", "icon")} aria-label="Suche" title="Ticketsuche">
            <Search className="h-5 w-5" />
          </Link>
          <span aria-hidden className="mx-0.5 !h-6 !w-px bg-border sm:mx-1" />
          <Link href="/settings" className={buttonClass("ghost", "icon")} aria-label="Einstellungen" title="Einstellungen">
            <Settings className="h-5 w-5" />
          </Link>
          <ThemeToggle />
          <Button variant="ghost" size="icon" aria-label="Abmelden" onClick={logout}>
            <LogOut className="h-5 w-5" />
          </Button>
        </nav>
      </div>
      {center && <div className="container pb-2 sm:hidden">{center}</div>}
      <TodayBanner />
    </header>
  );
}
