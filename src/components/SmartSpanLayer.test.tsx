import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PageViewport } from 'pdfjs-dist';
import type { DetectedDate } from '@/lib/smart/dateDetect';
import type { DetectedLocation } from '@/lib/smart/locationDetect';
import { LocationActionPopover } from './LocationActionPopover';
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
const location: DetectedLocation = {
  text: 'Goa',
  kind: 'location',
  pageIndex: 0,
  rect: { x: 130, y: 700, w: 24, h: 12 },
};

describe('SmartSpanLayer', () => {
  it('keeps date spans and renders location spans through the shared layer', () => {
    const html = renderToStaticMarkup(
      <SmartSpanLayer dates={[date]} locations={[location]} viewport={viewport} dpr={1} />,
    );

    expect(html).toContain('aria-label="Date actions: 27 November 1943"');
    expect(html).toContain('aria-label="Location actions: Goa"');
    expect(html).toContain('data-location-underline="true"');
    expect(html).toContain('data-testid="location-underline"');
    expect(html).toContain('background-color:#0F6E56');
    expect(html).not.toContain('data-location-chip');
    expect(html).not.toContain('data-testid="location-pin"');
    expect(html).not.toContain('background-color:#E1F5EE');
    expect(html).toContain('border-amber-600');
    expect(html.match(/border-amber-600/g)).toHaveLength(1);
  });

  it('keeps the location hit target at the original text width', () => {
    const html = renderToStaticMarkup(
      <SmartSpanLayer dates={[]} locations={[location]} viewport={viewport} dpr={1} />,
    );

    expect(html).toContain('left:130px');
    expect(html).toContain('width:24px');
    expect(html).not.toContain('padding');
    expect(html).not.toContain('rounded-full');
  });

  it('offers exactly the two requested location actions', () => {
    const html = renderToStaticMarkup(
      <LocationActionPopover
        detected={location}
        screenRect={{ left: 130, top: 80, width: 24, height: 12 }}
        pageWidth={612}
        onClose={() => undefined}
      />,
    );

    expect(html).toContain('Search Google');
    expect(html).toContain('Open in Google Maps');
    expect(html.match(/role="menuitem"/g)).toHaveLength(2);
  });
});
