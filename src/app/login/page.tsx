"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { TrainFront } from "lucide-react";
import { Button, Card, Input, Spinner } from "@/components/ui";
import { safeNextPath } from "@/lib/safeRedirect";

export default function LoginPage() {
  return (
    <React.Suspense fallback={null}>
      <LoginForm />
    </React.Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    setLoading(false);
    if (res.ok) {
      // Only same-site paths — never an open redirect to another host.
      const next = safeNextPath(params.get("next"));
      router.push(next);
      router.refresh();
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data.error || "Anmeldung fehlgeschlagen");
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm p-7">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/15 text-primary">
            <TrainFront className="h-7 w-7" />
          </div>
          <h1 className="text-xl font-semibold">Sparpreis-Explorer</h1>
          <p className="mt-1 text-sm text-muted-foreground">Bitte anmelden, um fortzufahren.</p>
        </div>
        <form onSubmit={submit} className="space-y-4">
          <Input
            type="password"
            autoFocus
            placeholder="Passwort"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {error && <p className="text-sm text-danger">{error}</p>}
          <Button type="submit" size="lg" className="w-full" disabled={loading}>
            {loading ? <Spinner /> : "Anmelden"}
          </Button>
        </form>
      </Card>
    </main>
  );
}
