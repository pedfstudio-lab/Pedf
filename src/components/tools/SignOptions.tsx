import { useEffect, useMemo, useRef, useState } from 'react';
import { SignatureMaker } from '@/components/sign/SignatureMaker';
import { previewPdfPage, previewPdfPages, type PreviewPageSize } from '@/lib/tools/preview';
import {
  formatSignDate,
  parseSignOptions,
  signatureLimits,
  signatureRect,
  type SignDate,
  type SignOptionsValue,
  type SignPageSelection,
} from '@/lib/tools/signOptions';
import type { ToolOptionsProps } from '@/lib/tools/types';
import { PlacementStage } from './PlacementStage';

interface PreviewPage {
  thumbnail?: string;
}

interface StagePage { thumbnail: string; size: PreviewPageSize }

const STAGE_LONG_SIDE = 420;

export function SignOptions({ options, onChange, inputs, disabled }: ToolOptionsProps) {
  const value = useMemo(() => parseSignOptions(options), [options]);
  const file = inputs[0];
  const [pages, setPages] = useState<PreviewPage[]>([]);
  const [pickerFailed, setPickerFailed] = useState(false);
  const [stagePage, setStagePage] = useState<StagePage | null>(null);
  const [stageFailed, setStageFailed] = useState(false);
  const [changingSignature, setChangingSignature] = useState(false);
  const latestValue = useRef(value);
  latestValue.current = value;
  const update = (next: Partial<SignOptionsValue>) => onChange({ ...value, ...next });

  useEffect(() => {
    setPages([]);
    setPickerFailed(false);
    if (!file) return;
    const controller = new AbortController();
    let initialPageSet = false;
    void previewPdfPages(file, controller.signal, (pageIndex, thumbnail) => {
      setPages((current) => {
        const next = [...current];
        next[pageIndex] = { thumbnail };
        return next;
      });
    }, 140, (count) => {
      setPages(Array.from({ length: count }, () => ({})));
      if (!initialPageSet && count > 0) {
        initialPageSet = true;
        onChange({ ...latestValue.current, pageIndex: count - 1 });
      }
    }).catch(() => { if (!controller.signal.aborted) setPickerFailed(true); });
    return () => controller.abort();
    // Reset to the last page only when a new file arrives, not when options change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  const signatureUrl = useMemo(() => value.signature
    ? URL.createObjectURL(new Blob([value.signature.png.slice().buffer], { type: 'image/png' }))
    : '', [value.signature]);
  useEffect(() => () => { if (signatureUrl) URL.revokeObjectURL(signatureUrl); }, [signatureUrl]);

  const displayedIndex = value.pageSelection === 'all' ? 0 : Math.min(value.pageIndex, Math.max(0, pages.length - 1));
  useEffect(() => {
    setStagePage(null);
    setStageFailed(false);
    if (!file) return;
    const controller = new AbortController();
    const longSide = STAGE_LONG_SIDE * Math.min(2, window.devicePixelRatio || 1);
    void previewPdfPage(file, displayedIndex, controller.signal, longSide)
      .then((result) => { if (!controller.signal.aborted) setStagePage(result); })
      .catch(() => { if (!controller.signal.aborted) setStageFailed(true); });
    return () => controller.abort();
  }, [displayedIndex, file]);

  const imageAspect = value.signature ? value.signature.width / value.signature.height : 1;
  const rect = stagePage ? signatureRect(stagePage.size.w, stagePage.size.h, value, imageAspect) : undefined;
  const limits = stagePage ? signatureLimits(stagePage.size.w, stagePage.size.h, value, imageAspect) : undefined;
  const stageWidth = stagePage
    ? Math.round(STAGE_LONG_SIDE * stagePage.size.w / Math.max(stagePage.size.w, stagePage.size.h)) : 0;
  const dateText = formatSignDate(value.date);

  return <fieldset className="tool-options sign-options" disabled={disabled}>
    <legend>Signature</legend>
    <p className="sign-kind-note">Adds a picture of your signature. It is not a certified digital signature (DSC or Aadhaar e-Sign).</p>

    <section className="sign-step">
      <h3><span>1</span> Make or pick a signature</h3>
      {!value.signature || changingSignature ? <SignatureMaker onDone={(signature) => {
        update({ signature });
        setChangingSignature(false);
      }} onCancel={value.signature ? () => setChangingSignature(false) : undefined} /> : <div className="sign-selected-signature">
        <div className="signature-upload-preview"><img src={signatureUrl} alt="Chosen signature" /></div>
        <div><strong>Signature ready</strong><small>It stays on this device.</small></div>
        <button type="button" className="tool-secondary" onClick={() => setChangingSignature(true)}>Change</button>
      </div>}
    </section>

    <section className="sign-step">
      <h3><span>2</span> Place it</h3>
      {!file ? <p className="tool-hint">Choose a PDF above to place the signature.</p> : <>
        {value.pageSelection !== 'all' && pages.length > 1 && <div className="sign-page-picker" aria-label="Choose preview page">
          {pages.map((page, index) => <button key={index} type="button" aria-pressed={displayedIndex === index}
            aria-label={`Page ${index + 1}`} onClick={() => update({ pageIndex: index })}>
            {page.thumbnail ? <img src={page.thumbnail} alt="" /> : <span>...</span>}<small>{index + 1}</small>
          </button>)}
        </div>}

        <div className="sign-placement-preview">
          {stagePage && value.signature && rect ? <PlacementStage
            className="sign-placement-stage"
            handleClassName="sign-placement-handle"
            pageImage={stagePage.thumbnail}
            imageAlt={`Page ${displayedIndex + 1} preview`}
            pageWidth={stagePage.size.w}
            pageHeight={stagePage.size.h}
            value={{
              x: rect.centreX,
              y: rect.centreYFromTop,
              widthShare: rect.width / stagePage.size.w,
              heightShare: rect.height / stagePage.size.h,
            }}
            limits={limits}
            onChange={(next) => update({ x: next.x, y: next.y, widthShare: next.widthShare })}
            disabled={disabled}
            resizable
            aspectRatio={imageAspect}
            minSizePx={40}
            label="Move the signature. Drag it, resize it from a corner, or use the arrow keys."
            title="Drag to place the signature"
            style={{ width: `min(100%, ${stageWidth}px)`, aspectRatio: `${stagePage.size.w} / ${stagePage.size.h}` }}
          ><div className="sign-stamp"><img src={signatureUrl} alt="" draggable={false} />
            {dateText && <small>{dateText}</small>}
          </div></PlacementStage> : <span>{stageFailed ? 'Preview unavailable' : value.signature
            ? 'Preparing page preview...' : 'Make or pick a signature to place it.'}</span>}
        </div>
        {pickerFailed && <p className="tool-hint">Some page thumbnails could not be prepared.</p>}
        {value.signature && <p className="tool-hint sign-placement-hint">Drag the signature into place. Use the corner dots to resize it.</p>}

        <div className="sign-options-grid">
          <label className="tool-select-field">Add the date
            <select value={value.date} onChange={(event) => update({ date: event.target.value as SignDate })}>
              <option value="none">No date</option>
              <option value="text">{formatSignDate('text')}</option>
              <option value="numeric">{formatSignDate('numeric')}</option>
            </select>
          </label>
          <label className="tool-select-field">Apply to
            <select value={value.pageSelection} onChange={(event) => update({ pageSelection: event.target.value as SignPageSelection })}>
              <option value="one">This page</option><option value="all">All pages</option><option value="custom">Only these pages</option>
            </select>
          </label>
        </div>
        {value.pageSelection === 'custom' && <div className="tool-option-details tool-page-selection sign-ranges">
          <label htmlFor="sign-ranges">Pages or ranges</label>
          <input id="sign-ranges" type="text" inputMode="numeric" value={value.ranges}
            placeholder="1-3, 5, 8-10" onChange={(event) => update({ ranges: event.target.value })} />
          <p className="tool-hint">Use commas between pages or ranges.</p>
        </div>}
      </>}
    </section>
  </fieldset>;
}
