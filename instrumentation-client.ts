import { installTranslationSafeDom } from "@/lib/translation-safety";

// Runs before the app becomes interactive, so React never sees an unpatched
// DOM. Spanish-speaking visitors use their browser's translator; see
// lib/translation-safety.ts for why that needs this.
try {
  installTranslationSafeDom();
} catch {
  // Never let a safety shim stop the page from loading.
}
