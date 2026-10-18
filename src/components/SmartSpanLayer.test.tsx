import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PageViewport } from 'pdfjs-dist';
import type { DetectedDate } from '@/lib/smart/dateDetect';
import { SmartSpanLayer } from './SmartSpanLayer';

const viewport = {
  width: 612,
  convertToViewportPoint: (x: number, y: number) => [x, 792 - y],
} as PageViewport;
const date: DetectedDate = {
  raw: '27 November 1943',
  startISO: '1943-11-27',
  allDay: true,
  pageIndex: 0,
  rect: { x: 20, y: 700, w: 90, h: 12 },
  contextText: 'Founded on 27 November 1943 in Goa.',
};

describe('SmartSpanLayer', () => {
  it('renders date spans only — no place-name underlines', () => {
    const html = renderToStaticMarkup(<SmartSpanLayer dates={[date]} viewport={viewport} dpr={1} />);

    expect(html).toContain('aria-label="Date actions: 27 November 1943"');
    expect(html.match(/border-amber-600/g)).toHaveLength(1);
    expect(html).not.toContain('Location actions');
    expect(html).not.toContain('data-location-underline');
  });

  it('keeps the date hit target at the original text width', () => {
    const html = renderToStaticMarkup(<SmartSpanLayer dates={[date]} viewport={viewport} dpr={1} />);

    expect(html).toContain('left:20px');
    expect(html).toContain('width:90px');
  });
});
