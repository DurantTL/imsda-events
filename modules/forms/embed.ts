type RegistrationEmbedCodeInput = {
  origin: string;
  eventSlug: string;
  formSlug: string;
  eventName: string;
};

function escapeHtmlAttribute(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function buildRegistrationEmbedCode(input: RegistrationEmbedCodeInput) {
  const origin = new URL(input.origin).origin;
  const embedUrl = new URL(
    `/embed/${encodeURIComponent(input.eventSlug)}/${encodeURIComponent(input.formSlug)}`,
    origin,
  ).toString();
  const hostScriptUrl = new URL("/embed/embed-host.js", origin).toString();
  const title = `${input.eventName.trim()} registration`;

  return [
    '<iframe class="imsda-embed"',
    `        src="${escapeHtmlAttribute(embedUrl)}"`,
    `        title="${escapeHtmlAttribute(title)}"`,
    '        width="100%" height="900" style="border:0;display:block"></iframe>',
    `<script src="${escapeHtmlAttribute(hostScriptUrl)}" async></script>`,
  ].join("\n");
}
