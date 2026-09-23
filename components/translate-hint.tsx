import { Languages } from "lucide-react";

/**
 * The site is English-first; Spanish-speaking visitors use their browser's
 * built-in translator (see lib/translation-safety.ts). This points them to it.
 * The Spanish half is marked `lang="es"`, so it is readable before the page is
 * translated and translators leave it as written.
 */
export const BROWSER_TRANSLATE_HELP_URL = "https://support.google.com/chrome/answer/173424?hl=es";

export function TranslateHint() {
  return (
    <p className="translate-hint">
      <Languages aria-hidden="true" size={16} />
      <span>
        <span lang="es">¿Necesita español? Use la opción «Traducir» de su navegador.</span>{" "}
        <span>Need another language? Use your browser&rsquo;s Translate option.</span>{" "}
        <a href={BROWSER_TRANSLATE_HELP_URL} rel="noreferrer" target="_blank">
          <span lang="es">Cómo traducir</span> / How to translate
        </a>
      </span>
    </p>
  );
}
