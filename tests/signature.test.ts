import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { fit } from "@/lib/trips/claimForm";
import { processSignature } from "@/lib/trips/signature";

describe("Formularfelder", () => {
  it("kürzt lange Haltestellen sinnvoll statt mitten im Wort", () => {
    expect(fit("Bleibach Bahnhof, Gutach im Breisgau", 26)).toBe("Bleibach Bf,Gutach");
    expect(fit("Neueck, Triberg im Schwarzwald", 26)).toBe("Neueck, Triberg/Schw.");
    expect(fit("Frankfurt(M) Flughafen Fernbf", 23)).toBe("Ffm Flugh. Fbf");
    expect(fit("Köln Hbf", 26)).toBe("Köln Hbf");
  });
});

describe("Unterschrift", () => {
  it("entfernt den hellen Hintergrund und schneidet auf die Schrift zu", async () => {
    // 400×200 light-grey "paper" with a dark stroke in the middle.
    const photo = await sharp({ create: { width: 400, height: 200, channels: 3, background: { r: 235, g: 235, b: 230 } } })
      .composite([{ input: Buffer.from('<svg width="400" height="200"><path d="M100 120 L300 80" stroke="#111" stroke-width="6"/></svg>') }])
      .jpeg()
      .toBuffer();
    const png = await processSignature(photo);
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(4);
    expect(info.width).toBeLessThan(230); // cropped to the stroke (+ padding)
    expect(data[3]).toBe(0); // corner transparent
    const alpha = Array.from({ length: info.width * info.height }, (_, i) => data[i * 4 + 3]);
    expect(Math.max(...alpha)).toBe(255); // ink opaque
  });

  it("lehnt ein leeres Bild ab", async () => {
    const blank = await sharp({ create: { width: 200, height: 100, channels: 3, background: "#fff" } }).png().toBuffer();
    await expect(processSignature(blank)).rejects.toThrow(/Keine Unterschrift/);
  });
});
