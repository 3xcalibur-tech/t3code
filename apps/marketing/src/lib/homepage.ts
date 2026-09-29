import { fetchLatestRelease, RELEASES_URL, type ReleaseAsset } from "../lib/releases";
import { startHomeMotion } from "../lib/homeMotion";

type Platform = { os: "mac" | "win" | "linux" };

function detectPlatform(): Platform | null {
  const ua = navigator.userAgent;
  if (/Win/i.test(ua)) return { os: "win" };
  if (/Mac/i.test(ua)) return { os: "mac" };
  if (/Linux/i.test(ua)) return { os: "linux" };
  return null;
}

// Macs always get the arm64 build. Browsers cannot reliably tell Apple Silicon
// from Intel (the UA lies, GPU strings lie), and a wrong guess hands an Apple
// Silicon user a broken app. Intel users pick their build on /download.
// Do NOT add arch detection back here.
function pickAsset(assets: ReleaseAsset[], platform: Platform): string | null {
  if (platform.os === "win") {
    return assets.find((a) => a.name.endsWith("-x64.exe"))?.browser_download_url ?? null;
  }
  if (platform.os === "mac") {
    return assets.find((a) => a.name.endsWith("-arm64.dmg"))?.browser_download_url ?? null;
  }
  if (platform.os === "linux") {
    return assets.find((a) => a.name.endsWith("-x86_64.AppImage"))?.browser_download_url ?? null;
  }
  return null;
}

async function init() {
  const btn = document.getElementById("download-btn") as HTMLAnchorElement | null;
  const label = document.getElementById("download-label");
  const ctaBtn = document.getElementById("cta-download-btn") as HTMLAnchorElement | null;
  const ctaLabel = document.getElementById("cta-download-label");
  const kbd = document.getElementById("pr-button-kbd");

  const platform = detectPlatform();
  if (!platform) return;
  document.documentElement.dataset.platform = platform.os;
  for (const element of [label, ctaLabel]) {
    const translatedLabel = element?.getAttribute(`data-label-${platform.os}`);
    if (element && translatedLabel) element.textContent = translatedLabel;
  }
  if (kbd && platform.os !== "mac") kbd.textContent = "Ctrl ⏎";

  try {
    const release = await fetchLatestRelease();
    const url = pickAsset(release.assets ?? [], platform);
    if (url) {
      if (btn) {
        btn.href = url;
        btn.removeAttribute("target");
        btn.removeAttribute("rel");
      }
      if (ctaBtn) {
        ctaBtn.href = url;
        ctaBtn.removeAttribute("target");
        ctaBtn.removeAttribute("rel");
      }
    }
  } catch {
    if (btn) btn.href = RELEASES_URL;
    if (ctaBtn) ctaBtn.href = RELEASES_URL;
  }
}

init();

const hero = document.querySelector<HTMLElement>(".hero");
const field = document.querySelector<HTMLElement>(".hero-float");
const tracks = Array.from(document.querySelectorAll<HTMLElement>(".endorsement-track"));
const caret = document.querySelector<HTMLElement>(".caret");
if (hero && field && caret) {
  startHomeMotion({ hero, field, tracks, caret });
}
