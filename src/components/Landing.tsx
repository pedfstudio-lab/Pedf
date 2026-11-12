import { setPendingFile, setPendingProject } from '@/lib/site/pendingFile';
import { navigate } from '@/lib/site/navigate';
import { siteHref } from '@/lib/site/config';
import type { ReactNode } from 'react';
import type { ProjectStore } from '@/lib/projects/projectStore';
import { SUPPORTED_LANGUAGES } from '@/state/prefsStore';
import { SiteFooter, SiteHeader } from './SiteChrome';
import { ContinueEditingCard } from './ContinueEditingCard';
import { PdfDropZone } from './PdfDropZone';
import './landing.css';

// The card title says it all; the pictures are decoration (empty alt).
const features = [
  { title: 'PDF tools', image: 'cube-upload.webp', href: '/tools' },
  { title: 'Edit Text', image: 'cube-text.webp', href: '/app' },
  { title: 'Add / Edit Image', image: 'cube-image.webp', href: '/app' },
  { title: 'Ask the Bot', image: 'cube-bot.webp', href: '/app' },
] as const;

/** Each language written in its own script, so a Tamil reader sees தமிழ். */
const languageList = SUPPORTED_LANGUAGES.map((language, index) => (
  <span key={language.code}>
    {index > 0 && ', '}
    <span lang={language.code}>{language.label}</span>
    {language.code !== 'en-IN' && ` (${language.name})`}
  </span>
));

const faqs: ReadonlyArray<readonly [string, ReactNode]> = [
  ['Is it free?', 'Yes. PEDF Studio is free to use.'],
  ['Do I need an account?', 'No. Open the page and start with a PDF.'],
  ['Does it work offline?', 'Editing works offline once the page is open. Chat, voice and Translate need an internet connection.'],
  ['Which languages are supported?', <>{languageList}.</>],
  ['Where is my file stored?', 'Your PDF and saved edits stay only in this browser on this device. You download the edited copy when you are ready.'],
  ['What do voice and chat need?', 'Nothing to set up. Ask, voice and Translate work straight away; they just need an internet connection.'],
  ['Can I use it on my phone?', 'Yes. You can open and read your PDF, ask questions and translate it on a phone. Editing works best on a computer.'],
];

export function Landing({ projectStore }: { readonly projectStore?: ProjectStore } = {}) {
  const openFile = (file: File) => {
    setPendingFile(file);
    navigate('/app');
  };
  const continueProject = (id: string) => {
    setPendingProject(id);
    navigate('/app');
    return true;
  };

  return (
    <div className="site-page landing-page">
      <SiteHeader />
      <main id="main-content">
        {/* "Drop-first": one wide drop area is the first thing you see; three cards under
            it say what happens after. Everything fits on a 1366 × 768 laptop. */}
        <section className="site-shell hero" aria-labelledby="hero-title">
          <p className="site-eyebrow">Your PDF, finally editable</p>
          <h1 id="hero-title"><span>Read it. </span><span className="hero__accent">Ask it. </span><span>Edit it.</span></h1>
          <p className="hero__lede">Type or talk to understand any PDF, then edit the text and images. Runs on your computer.</p>
          <div className="hero__start">
            <ContinueEditingCard store={projectStore} onContinue={continueProject} compact />
            <PdfDropZone onFile={openFile} variant="wide" />
            <p className="hero__privacy">
              <span className="hero__tick" aria-hidden="true">✓</span>
              <strong>Your PDF never leaves your device.</strong> Only Ask, voice and Translate send text out — to get your answer.
            </p>
            <ul className="hero__cards" aria-label="What you can do">
              <li>
                <img src={siteHref('landing/hero-doc.webp')} width="62" height="62" alt="" />
                {/* Phones show the shorter wording, so the first card fits the first screen. */}
                <div><strong>Read it</strong><span>See any page in <span lang="hi">हिन्दी</span>, <span lang="ta">தமிழ்</span><span className="hero__long">, <span lang="bn">বাংলা</span> and more</span><span className="hero__short">…</span></span></div>
              </li>
              <li>
                <img src={siteHref('landing/cube-bot.webp')} width="62" height="62" alt="" />
                <div><strong>Ask it</strong><span>Type or talk<span className="hero__long">, and get answers from your PDF</span><span className="hero__short">, get answers</span></span></div>
              </li>
              <li>
                <img src={siteHref('landing/cube-text.webp')} width="62" height="62" alt="" />
                <div><strong>Edit it</strong><span>Click any word and change it</span></div>
              </li>
            </ul>
          </div>
        </section>

        <section className="features site-shell" id="features" aria-labelledby="features-title">
          <p className="site-eyebrow">Everything you need</p>
          <h2 id="features-title">A simpler way to work with PDFs.</h2>
          <div className="features__grid">
            {features.map((feature) => (
              <a className="feature" key={feature.title} href={siteHref(feature.href)}>
                <img src={siteHref(`landing/${feature.image}`)} width="350" height="539" alt="" loading="lazy" decoding="async" />
                <h3>{feature.title}</h3>
              </a>
            ))}
          </div>
        </section>

        <section className="how site-shell" id="how" aria-labelledby="how-title">
          <div>
            <p className="site-eyebrow">How it works</p>
            <h2 id="how-title">From PDF to done in three steps.</h2>
          </div>
          <ol className="how__steps">
            <li><span>1</span><div><strong>Open your PDF.</strong><p>Drop it above or choose it from your computer.</p></div></li>
            <li><span>2</span><div><strong>Edit or ask.</strong><p>Tap text or images, or ask the bot by typing or talking.</p></div></li>
            <li><span>3</span><div><strong>Download it.</strong><p>Download the finished PDF straight back to your computer.</p></div></li>
          </ol>
        </section>

        <section className="privacy-band" id="privacy" aria-labelledby="privacy-title">
          <div className="site-shell privacy-band__inner">
            <div className="privacy-band__art">
              <img src={siteHref('landing/laptop-lock.webp')} width="900" height="600" alt="3D laptop, PDF page, and padlock" loading="lazy" decoding="async" />
            </div>
            <div className="privacy-band__copy">
              <p className="site-eyebrow">Private by design</p>
              <h2 id="privacy-title">Runs on your computer.{' '}<span>Stays on your computer.</span></h2>
              <p>Everything is processed in your browser. Your PDF never leaves your device.</p>
              <p className="privacy-band__detail">Chat, voice and Translate send only your question, your audio, and the document’s text to Sarvam AI to get an answer or a translation. Nothing is stored.</p>
              <a href={siteHref('/privacy')}>Read our privacy notes <span aria-hidden="true">→</span></a>
            </div>
          </div>
        </section>

        <section className="trust-strip site-shell" aria-label="Trust and language support">
          <div><span className="trust-strip__icon" aria-hidden="true">✓</span><strong>Your files never leave your device</strong></div>
          <div className="trust-strip__divider" aria-hidden="true" />
          <div><span className="trust-strip__language" aria-hidden="true">अ</span><strong>English, <span lang="hi-IN">हिन्दी</span>, <span lang="ta-IN">தமிழ்</span> &amp; 7 more Indian languages</strong></div>
        </section>
        <p className="trust-note site-shell">Only Ask, voice and Translate send text out — to get your answer.</p>

        <section className="faq site-shell" id="faq" aria-labelledby="faq-title">
          <div className="faq__intro">
            <p className="site-eyebrow">Questions, answered</p>
            <h2 id="faq-title">Good to know before you begin.</h2>
          </div>
          <div className="faq__grid">
            {faqs.map(([question, answer]) => (
              <details key={question}>
                <summary>{question}<span aria-hidden="true">+</span></summary>
                <p>{answer}</p>
              </details>
            ))}
          </div>
        </section>

      </main>
      <SiteFooter />
    </div>
  );
}
