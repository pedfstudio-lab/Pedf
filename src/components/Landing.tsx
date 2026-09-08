import { useRef, useState, type DragEvent } from 'react';
import { setPendingFile } from '@/lib/site/pendingFile';
import { navigate } from '@/lib/site/navigate';
import { siteHref } from '@/lib/site/config';
import { SiteFooter, SiteHeader } from './SiteChrome';
import './landing.css';

const features = [
  { title: 'Upload PDF', image: 'cube-upload.webp', alt: '3D upload arrow' },
  { title: 'Edit Text', image: 'cube-text.webp', alt: '3D text symbol' },
  { title: 'Add / Edit Image', image: 'cube-image.webp', alt: '3D image symbol' },
  { title: 'Ask the Bot', image: 'cube-bot.webp', alt: '3D chat symbol' },
] as const;

const faqs = [
  ['Is it free?', 'Yes. PEDF Studio is free to use.'],
  ['Do I need an account?', 'No. Open the page and start with a PDF.'],
  ['Does it work offline?', 'Editing works offline once the page is open. Voice and chat need an internet connection.'],
  ['Which languages are supported?', 'English, Hindi, Tamil, Bengali, Telugu, Marathi, Gujarati, Kannada, Malayalam, and Punjabi.'],
  ['Where is my file stored?', 'Nowhere. It stays in your browser, and you download the edited copy when you are ready.'],
  ['What does voice need?', 'A Sarvam API key in Settings until our managed proxy goes live.'],
] as const;

function isPdf(file: File): boolean {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
}

export function Landing() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [fileError, setFileError] = useState('');

  const openFile = (file: File | undefined) => {
    if (!file) return;
    if (!isPdf(file)) {
      setFileError('Choose a PDF file to continue.');
      return;
    }
    setFileError('');
    setPendingFile(file);
    navigate('/app');
  };

  const onDrop = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setDragging(false);
    openFile(event.dataTransfer.files[0]);
  };

  return (
    <div className="site-page landing-page">
      <SiteHeader />
      <main>
        <section className="site-shell hero" aria-labelledby="hero-title">
          <div className="hero__copy">
            <p className="site-eyebrow">Your PDF, finally editable</p>
            <h1 id="hero-title"><span>Read it. </span><span className="hero__blue">Ask it. </span><span>Edit it.</span></h1>
            <p className="hero__lede">Type or talk to understand any PDF, then edit the text and images. Runs on your computer.</p>
            <button
              type="button"
              className={`drop-zone${dragging ? ' drop-zone--active' : ''}`}
              onClick={() => inputRef.current?.click()}
              onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              aria-describedby="pdf-upload-help pdf-upload-error"
            >
              <span className="drop-zone__icon" aria-hidden="true">
                <svg viewBox="0 0 48 56" fill="none"><path d="M9 3h21l9 9v41H9z" fill="white"/><path d="M30 3v10h9" stroke="#8EC8FF" strokeWidth="3"/><path d="M24 39V22m-7 7 7-7 7 7" stroke="#126BFF" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </span>
              <span><strong>Drag &amp; drop your PDF here</strong><small id="pdf-upload-help">or click to upload</small></span>
            </button>
            <input
              ref={inputRef}
              type="file"
              accept="application/pdf"
              className="sr-only"
              onChange={(event) => {
                openFile(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
            <p id="pdf-upload-error" className="drop-zone__error" role="alert">{fileError}</p>
          </div>

          <div className="hero__visual" aria-label="A PDF document opening into a voice chat">
            <div className="hero__glow" aria-hidden="true" />
            <img src={siteHref('landing/hero-doc.webp')} width="1100" height="825" alt="3D PDF document with a folded blue corner and chat panel" />
            <div className="chat-demo" aria-hidden="true">
              <div className="chat-demo__question">What does clause 4 mean?<span className="chat-demo__mic">●</span></div>
              <div className="chat-demo__answer">Clause 4 refers to termination by either party with 30 days’ written notice.</div>
              <div className="chat-demo__field">Ask anything…<span>●</span></div>
            </div>
          </div>
        </section>

        <section className="features site-shell" id="features" aria-labelledby="features-title">
          <p className="site-eyebrow">Everything you need</p>
          <h2 id="features-title">A simpler way to work with PDFs.</h2>
          <div className="features__grid">
            {features.map((feature) => (
              <article className="feature" key={feature.title}>
                <img src={siteHref(`landing/${feature.image}`)} width="350" height="539" alt={feature.alt} />
                <h3>{feature.title}</h3>
              </article>
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
            <li><span>3</span><div><strong>Download it.</strong><p>Export the finished PDF straight back to your computer.</p></div></li>
          </ol>
        </section>

        <section className="privacy-band" id="privacy" aria-labelledby="privacy-title">
          <div className="site-shell privacy-band__inner">
            <div className="privacy-band__art">
              <img src={siteHref('landing/laptop-lock.webp')} width="900" height="600" alt="3D laptop, PDF page, and padlock" />
            </div>
            <div className="privacy-band__copy">
              <p className="site-eyebrow">Private by design</p>
              <h2 id="privacy-title">Runs on your computer.<span>Stays on your computer.</span></h2>
              <p>Everything is processed in your browser. Your PDF never leaves your device.</p>
              <p className="privacy-band__detail">Voice and chat send only your question, your audio, and the document’s text to Sarvam AI to get an answer. Nothing is stored.</p>
              <a href={siteHref('/privacy')}>Read our privacy notes <span aria-hidden="true">→</span></a>
            </div>
          </div>
        </section>

        <section className="trust-strip site-shell" aria-label="Trust and language support">
          <div><span className="trust-strip__icon" aria-hidden="true">✓</span><strong>Your files never leave your device</strong></div>
          <div className="trust-strip__divider" aria-hidden="true" />
          <div><span className="trust-strip__language" aria-hidden="true">अ</span><strong>English, Hindi &amp; 8 more Indian languages</strong></div>
        </section>

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
