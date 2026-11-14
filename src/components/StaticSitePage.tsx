import { siteHref, SUPPORT_EMAIL } from '@/lib/site/config';
import { SUPPORTED_LANGUAGES } from '@/state/prefsStore';
import { StaticPageShell } from './SiteChrome';

type StaticPageKind = 'privacy' | 'terms' | 'support';

/** Who the terms are an agreement with. Before paid plans, add a refund policy and complaints contact too. */
const OWNER_NAME = 'Utkarsh Taneja';
const TERMS_UPDATED = '14 November 2026';

export function StaticSitePage({ kind }: { readonly kind: StaticPageKind }) {
  if (kind === 'privacy') {
    return (
      <StaticPageShell>
        <main id="main-content" className="site-static site-shell">
          <p className="site-eyebrow">Privacy</p>
          <h1>Your PDF stays yours.</h1>
          <p>HighPal processes and saves your edits locally in your browser. Your PDF is not uploaded, stored, or associated with an account.</p>
          <p>When you use chat, voice or Translate, only your question, your audio, and the document text needed to answer or translate are sent, through HighPal's server, to Sarvam AI. HighPal does not store them.</p>
          <p>There are no accounts. You stay in control of the original file and the edited copy you download.</p>
          <p>To see how many people visit and which pages they use, HighPal uses Cloudflare Web Analytics. It counts visits without cookies and does not track you across other sites. It never sees your PDFs or anything you type.</p>
        </main>
      </StaticPageShell>
    );
  }

  if (kind === 'terms') {
    return (
      <StaticPageShell>
        <main id="main-content" className="site-static site-shell">
          <p className="site-eyebrow">Terms of use</p>
          <h1>The rules, in plain words.</h1>
          <p className="site-static__note">Last updated: {TERMS_UPDATED}</p>

          <h2>1. Who we are</h2>
          <p>HighPal (“HighPal”, “we”) is a professional PDF editor at highpal.ai. You can edit the text and images in your PDFs, sign them, and use our PDF tools. You can also talk to, chat with and ask questions about your document, by typing or by voice. HighPal is currently free to use and is run by {OWNER_NAME}, an individual based in Alwar, Rajasthan, India. By using HighPal you agree to these terms. If you don’t agree, please don’t use it.</p>

          <h2>2. Who can use HighPal</h2>
          <p>You should be 18 or older. If you’re under 18, use HighPal only with a parent’s or guardian’s permission.</p>

          <h2>3. Your documents</h2>
          <p>Your PDFs stay yours. HighPal opens, edits and saves them in your browser, on your device; we don’t upload or store them. Saved files live only in that browser. Clearing browser data, using a private window, or losing your device can remove them, so keep your own copies of anything important.</p>

          <h2>4. AI features (Ask, voice, Conversation, Translate)</h2>
          <p>These are powered by Sarvam AI. When you use them, your question, your voice recording, and the PDF text needed to answer or translate are sent through HighPal’s server to Sarvam AI (see our <a href={siteHref('/privacy')}>Privacy page</a>). AI answers and translations can be wrong or incomplete. They are general help, not legal, medical, financial or other professional advice, so check anything important against the original document or a qualified person. To keep things fair for everyone, we limit how often the AI features can be used and may change those limits.</p>

          <h2>5. Using HighPal responsibly</h2>
          <p>You must not use HighPal to:</p>
          <ul>
            <li>forge, falsify or alter documents to deceive anyone (for example identity documents, certificates, bank statements or government records), or for any kind of fraud;</li>
            <li>edit, unlock or share files you don’t have the right to;</li>
            <li>create or share illegal content, or content that breaks someone else’s rights;</li>
            <li>attack, overload, copy or misuse HighPal or its AI features, including through automated tools.</li>
          </ul>
          <p>You alone are responsible for the documents you edit and how you use them.</p>

          <h2>6. Password-protected PDFs</h2>
          <p>Only unlock PDFs you own or are allowed to open. HighPal never stores your password. If you forget it, we can’t recover it.</p>

          <h2>7. Free now, paid plans later</h2>
          <p>HighPal is free for now. We may add paid plans or a small subscription in future. If we do, we’ll clearly show the price and what’s included before you pay, and nothing will be charged without your agreement. We may change, add or remove features at any time.</p>

          <h2>8. No guarantees</h2>
          <p>HighPal is provided “as is”. We work hard to make it reliable, but we can’t promise it will always be available or error-free, or that every edit and export will be perfect. Check your documents before you use or send them.</p>

          <h2>9. Limits on our responsibility</h2>
          <p>As far as the law allows, we’re not responsible for lost files or data, or for any loss caused by using HighPal, its AI answers, or documents edited with it. If we are found responsible, our total liability is limited to the amount you paid us for HighPal in the 12 months before the claim, if any.</p>

          <h2>10. Other services</h2>
          <p>HighPal runs on Cloudflare and uses Sarvam AI for its AI features. Their own terms and privacy policies also apply to the parts they handle.</p>

          <h2>11. Changes to these terms</h2>
          <p>We may update these terms. The date at the top shows the latest version. If you keep using HighPal after a change, you accept the updated terms.</p>

          <h2>12. Law and disputes</h2>
          <p>These terms are governed by the laws of India. The courts at Alwar, Rajasthan have jurisdiction. If you have a problem, please email us first and we’ll try to sort it out.</p>

          <h2>13. Contact</h2>
          <p><a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a></p>
        </main>
      </StaticPageShell>
    );
  }

  return (
    <StaticPageShell>
      <main id="main-content" className="site-static site-shell">
        <p className="site-eyebrow">Support</p>
        <h1>How can we help?</h1>
        <p>Tell us what happened, which browser you use, and the language of your PDF.</p>
        <a className="site-button" href={`mailto:${SUPPORT_EMAIL}`}>Email {SUPPORT_EMAIL}</a>
        <p className="site-static__note">HighPal currently supports {SUPPORTED_LANGUAGES.length} languages.</p>
      </main>
    </StaticPageShell>
  );
}
