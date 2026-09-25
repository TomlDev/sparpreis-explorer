"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FlaskConical, LogOut, Settings, TrainFront } from "lucide-react";
import { Button } from "@/components/ui";
import { ThemeToggle } from "@/components/ThemeToggle";

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
        {center ? <div className="min-w-0 flex-1">{center}</div> : <div className="flex-1" />}
        <nav className="flex shrink-0 items-center gap-1">
          <Link href="/lab">
            <Button variant="ghost" size="icon" aria-label="Lab">
              <FlaskConical className="h-5 w-5" />
            </Button>
          </Link>
          <Link href="/settings">
            <Button variant="ghost" size="icon" aria-label="Einstellungen">
              <Settings className="h-5 w-5" />
            </Button>
          </Link>
          <ThemeToggle />
          <Button variant="ghost" size="icon" aria-label="Abmelden" onClick={logout}>
            <LogOut className="h-5 w-5" />
          </Button>
        </nav>
      </div>
    </header>
  );
}
