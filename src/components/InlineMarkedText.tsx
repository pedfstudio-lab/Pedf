import type { HTMLAttributes } from 'react';
import type { TextStyle } from '@/lib/export/types';
import { effectiveTextSpanStyle } from '@/lib/edit/richText';
import { textStyleToCss } from '@/lib/edit/textStyleCss';
import type { DetectedDate } from '@/lib/smart/dateDetect';
import type { InlineSegment } from '@/lib/smart/inlineMarks';
import { DATE_UNDERLINE_COLOR, DATE_UNDERLINE_OFFSET } from '@/lib/smart/underlineStyle';

interface InlineMarkedTextProps {
  readonly segments: readonly InlineSegment[];
  readonly style: TextStyle;
  readonly zoom: number;
  readonly marksHidden?: boolean;
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
  onDateClick,
}: InlineMarkedTextProps) {
  return segments.map((segment, index) => {
    const effectiveStyle = segment.span ? effectiveTextSpanStyle(style, segment.span) : style;
    const segmentStyle = textStyleToCss(
      effectiveStyle,
      zoom,
    );
    const content = effectiveStyle.fontIdentity
      ? (segment.text.match(/\s+|\S+/gu) ?? []).map((word, index) => <span key={index} style={textStyleToCss(effectiveStyle, zoom, word)}>{word}</span>)
      : segment.text;
    const key = `${index}:${segment.text}`;
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
          {content}
        </button>
      );
    }
    return <span key={key} style={segmentStyle}>{content}</span>;
  });
}
