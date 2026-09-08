import { SUPPORT_EMAIL } from '@/lib/site/config';
import { SUPPORTED_LANGUAGES } from '@/state/prefsStore';
import { StaticPageShell } from './SiteChrome';

type StaticPageKind = 'privacy' | 'terms' | 'support';

export function StaticSitePage({ kind }: { readonly kind: StaticPageKind }) {
  if (kind === 'privacy') {
    return (
      <StaticPageShell>
        <main className="site-static site-shell">
          <p className="site-eyebrow">Privacy</p>
          <h1>Your PDF stays yours.</h1>
          <p>PEDF Studio processes and saves your edits locally in your browser. Your PDF is not uploaded, stored, or associated with an account.</p>
          <p>When you use voice or chat, only your question, your audio, and the document text needed to answer are sent to Sarvam AI. PEDF Studio does not store them.</p>
          <p>There are no accounts and no analytics. You stay in control of the original file and the edited copy you download.</p>
        </main>
      </StaticPageShell>
    );
  }

  if (kind === 'terms') {
    return (
      <StaticPageShell>
        <main className="site-static site-shell">
          <p className="site-eyebrow">Terms</p>
          <h1>DRAFT — review before launch</h1>
          <p>PEDF Studio is provided as-is, without warranties or guarantees. You are responsible for reviewing the accuracy and suitability of every edit and exported document.</p>
          <p>You keep ownership of your documents and their contents. Do not use the service with files you do not have permission to edit.</p>
          <p>Features may change as the product develops. Continued use means you accept the current draft terms.</p>
        </main>
      </StaticPageShell>
    );
  }

  return (
    <StaticPageShell>
      <main className="site-static site-shell">
        <p className="site-eyebrow">Support</p>
        <h1>How can we help?</h1>
        <p>Tell us what happened, which browser you use, and the language of your PDF.</p>
        <a className="site-button" href={`mailto:${SUPPORT_EMAIL}`}>Email {SUPPORT_EMAIL}</a>
        <p className="site-static__note">PEDF Studio currently supports {SUPPORTED_LANGUAGES.length} languages.</p>
      </main>
    </StaticPageShell>
  );
}
