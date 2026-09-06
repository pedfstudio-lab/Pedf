import type { HTMLAttributes } from 'react';
import type { TextStyle } from '@/lib/export/types';
import { effectiveTextSpanStyle } from '@/lib/edit/richText';
import { textStyleToCss } from '@/lib/edit/textStyleCss';
import type { DetectedDate } from '@/lib/smart/dateDetect';
import type { InlineSegment } from '@/lib/smart/inlineMarks';
import {
  DATE_UNDERLINE_COLOR,
  DATE_UNDERLINE_OFFSET,
  LOCATION_UNDERLINE_COLOR,
  LOCATION_UNDERLINE_OFFSET,
} from '@/lib/smart/underlineStyle';

interface InlineMarkedTextProps {
  readonly segments: readonly InlineSegment[];
  readonly style: TextStyle;
  readonly zoom: number;
  readonly marksHidden?: boolean;
  onLocationClick(location: string, target: HTMLButtonElement): void;
  onDateClick(date: DetectedDate, target: HTMLButtonElement): void;
}

function underlineStyle(
  color: string,
  offset: number,
  decorationStyle: NonNullable<HTMLAttributes<HTMLElement>['style']>['textDecorationStyle'],
) {
  return {
    textDecorationLine: 'underline',
    textDecorationColor: color,
    textDecorationStyle: decorationStyle,
    textDecorationThickness: decorationStyle === 'dotted' ? '2px' : '1px',
    textUnderlineOffset: `${offset}px`,
  } as const;
}

export function InlineMarkedText({
  segments,
  style,
  zoom,
  marksHidden = false,
  onLocationClick,
  onDateClick,
}: InlineMarkedTextProps) {
  return segments.map((segment, index) => {
    const segmentStyle = textStyleToCss(
      segment.span ? effectiveTextSpanStyle(style, segment.span) : style,
      zoom,
    );
    const key = `${index}:${segment.text}`;
    if (segment.location && !marksHidden) {
      return (
        <button
          key={key}
          type="button"
          data-location-underline="true"
          aria-label={`Location actions: ${segment.location}`}
          title={`${segment.location} - location actions`}
          onClick={(event) => onLocationClick(segment.location as string, event.currentTarget)}
          className="pointer-events-auto inline cursor-pointer border-0 bg-transparent p-0 text-left align-baseline focus:outline-none focus:ring-2 focus:ring-emerald-700/40"
          style={{
            ...segmentStyle,
            ...underlineStyle(LOCATION_UNDERLINE_COLOR, LOCATION_UNDERLINE_OFFSET, 'solid'),
          }}
        >
          {segment.text}
        </button>
      );
    }
    if (segment.date && !marksHidden) {
      return (
        <button
          key={key}
          type="button"
          data-date-underline="true"
          aria-label={`Date actions: ${segment.date.raw}`}
          title={`${segment.date.raw} - calendar actions`}
          onClick={(event) => onDateClick(segment.date as DetectedDate, event.currentTarget)}
          className="pointer-events-auto inline cursor-pointer border-0 bg-transparent p-0 text-left align-baseline focus:outline-none focus:ring-2 focus:ring-amber-500/70"
          style={{
            ...segmentStyle,
            ...underlineStyle(DATE_UNDERLINE_COLOR, DATE_UNDERLINE_OFFSET, 'dotted'),
          }}
        >
          {segment.text}
        </button>
      );
    }
    return <span key={key} style={segmentStyle}>{segment.text}</span>;
  });
}
