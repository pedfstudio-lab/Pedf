/**
 * The editor's ready-made page (highpal.ai/app before its code has loaded). The editor itself
 * needs JavaScript, so this says what it is, for search engines and link previews, and shows
 * visitors that it's opening. The live editor replaces it a moment later.
 */
export function EditorIntro() {
  return (
    <main className="flex min-h-full flex-col items-center justify-center gap-3 bg-neutral-100 px-6 text-center">
      <h1 className="text-xl font-semibold text-neutral-900">HighPal PDF editor</h1>
      <p className="max-w-lg text-sm leading-relaxed text-neutral-600">
        Professional PDF editor in your browser: edit text and images, sign and add pages, or talk to and chat
        with your PDF in English and Indian languages. Your file stays on your device.
      </p>
      <p className="text-sm text-neutral-500">Opening the editor…</p>
      <noscript>
        <p className="text-sm font-semibold text-neutral-800">The editor needs JavaScript. Please turn it on in your browser.</p>
      </noscript>
    </main>
  );
}
