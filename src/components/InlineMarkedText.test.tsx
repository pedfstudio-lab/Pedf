/** @vitest-environment jsdom */

import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { DetectedLocation } from '@/lib/smart/locationDetect';
import { LocationActionPopover } from './LocationActionPopover';
import { InlineMarkedText } from './InlineMarkedText';

afterEach(cleanup);

const style = {
  fontName: 'Helvetica',
  fontSizePt: 12,
  bold: false,
  italic: false,
  color: { r: 0, g: 0, b: 0 },
};

function Harness() {
  const [selected, setSelected] = useState<DetectedLocation | null>(null);
  return (
    <div>
      <InlineMarkedText
        segments={[{ text: 'Morjim', location: 'Morjim' }]}
        style={style}
        zoom={1}
        onLocationClick={(text) => setSelected({
          text,
          kind: 'location',
          pageIndex: 0,
          rect: { x: 10, y: 20, w: 40, h: 12 },
        })}
        onDateClick={() => undefined}
      />
      {selected && (
        <LocationActionPopover
          detected={selected}
          screenRect={{ left: 10, top: 20, width: 40, height: 12 }}
          pageWidth={612}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

describe('InlineMarkedText', () => {
  it('renders a location underline button and opens the matching popover', () => {
    render(<Harness />);

    const button = screen.getByRole('button', { name: 'Location actions: Morjim' });
    expect(button.getAttribute('data-location-underline')).toBe('true');
    fireEvent.click(button);

    const dialog = screen.getByRole('dialog', { name: 'Location actions: Morjim' });
    expect(dialog).toBeTruthy();
    expect(within(dialog).getByText('Morjim')).toBeTruthy();
  });
});
