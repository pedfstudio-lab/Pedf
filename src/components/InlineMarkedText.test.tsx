/** @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { DetectedDate } from '@/lib/smart/dateDetect';
import { InlineMarkedText } from './InlineMarkedText';

afterEach(cleanup);

const style = {
  fontName: 'Helvetica',
  fontSizePt: 12,
  bold: false,
  italic: false,
  color: { r: 0, g: 0, b: 0 },
};
const date: DetectedDate = {
  raw: '23 September 2026',
  startISO: '2026-09-23',
  allDay: true,
  pageIndex: 0,
  rect: { x: 10, y: 20, w: 90, h: 12 },
  contextText: 'Arrive on 23 September 2026 in Ziro.',
};

describe('InlineMarkedText', () => {
  it('renders a date underline button and plain text around it', () => {
    const onDateClick = vi.fn();
    render(
      <div>
        <InlineMarkedText
          segments={[{ text: 'Arrive on ' }, { text: '23 September 2026', date }, { text: ' in Ziro.' }]}
          style={style}
          zoom={1}
          onDateClick={onDateClick}
        />
      </div>,
    );

    const button = screen.getByRole('button', { name: 'Date actions: 23 September 2026' });
    expect(button.getAttribute('data-date-underline')).toBe('true');
    fireEvent.click(button);
    expect(onDateClick).toHaveBeenCalledWith(date, button);
    expect(screen.getByText('in Ziro.', { exact: false }).tagName).toBe('SPAN');
    // Place names are never marked: the place-name feature sent the PDF's text to a server.
    expect(document.querySelector('[data-location-underline]')).toBeNull();
  });

  it('hides the date underline while its text is covered by the editor', () => {
    render(
      <div>
        <InlineMarkedText segments={[{ text: '23 September 2026', date }]} style={style} zoom={1}
          marksHidden onDateClick={() => undefined} />
      </div>,
    );
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('23 September 2026').tagName).toBe('SPAN');
  });
});
