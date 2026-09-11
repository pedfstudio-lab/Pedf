import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import caveatUrl from '@fontsource/caveat/files/caveat-latin-400-normal.woff2?url';
import dancingScriptUrl from '@fontsource/dancing-script/files/dancing-script-latin-400-normal.woff2?url';
import greatVibesUrl from '@fontsource/great-vibes/files/great-vibes-latin-400-normal.woff2?url';
import { cleanSignature, hasVisibleInk, shrinkForCleaning, trimToInk, type SignatureInk } from '@/lib/sign/cleanSignature';
import { deleteSaved, listSaved, saveSignature, type SavedSignature } from '@/lib/sign/savedSignatures';
import { HEIC_GUIDANCE, isHeicFile } from '@/lib/tools/files';
import { prepareImageForPdf } from '@/lib/tools/jpgToPdf';
import type { SignatureAsset } from '@/lib/tools/signOptions';
import './sign.css';

type MakerTab = 'draw' | 'type' | 'upload';
type InkColour = 'black' | 'blue';
type Point = { x: number; y: number };
type Stroke = { points: Point[]; colour: InkColour; thickness: number };

export interface SignatureMakerProps {
  onDone(signature: SignatureAsset): void;
  onCancel?: () => void;
}

const DRAW_WIDTH = 600;
const DRAW_HEIGHT = 220;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const TYPE_FONTS = [
  { id: 'caveat', label: 'Caveat', family: 'PEDF Caveat', url: caveatUrl },
  { id: 'dancing', label: 'Dancing Script', family: 'PEDF Dancing Script', url: dancingScriptUrl },
  { id: 'great-vibes', label: 'Great Vibes', family: 'PEDF Great Vibes', url: greatVibesUrl },
] as const;
type TypeFontId = typeof TYPE_FONTS[number]['id'];

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas is unavailable.');
  return context;
}

function drawStrokes(context: CanvasRenderingContext2D, strokes: readonly Stroke[], scale = 1): void {
  context.lineCap = 'round';
  context.lineJoin = 'round';
  for (const stroke of strokes) {
    const [first, ...rest] = stroke.points;
    if (!first) continue;
    context.beginPath();
    context.strokeStyle = stroke.colour === 'blue' ? '#164ca6' : '#121821';
    context.lineWidth = stroke.thickness * scale;
    context.moveTo(first.x * scale, first.y * scale);
    if (!rest.length) {
      context.lineTo((first.x + 0.1) * scale, (first.y + 0.1) * scale);
    } else {
      for (let index = 0; index < rest.length - 1; index++) {
        const point = rest[index]!;
        const next = rest[index + 1]!;
        context.quadraticCurveTo(point.x * scale, point.y * scale, (point.x + next.x) / 2 * scale, (point.y + next.y) / 2 * scale);
      }
      const last = rest.at(-1)!;
      context.lineTo(last.x * scale, last.y * scale);
    }
    context.stroke();
  }
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(
    (blob) => blob ? resolve(blob) : reject(new Error('The signature image could not be prepared.')),
    'image/png',
  ));
}

async function imageDataAsset(image: ImageData): Promise<SignatureAsset> {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  context2d(canvas).putImageData(image, 0, 0);
  const blob = await canvasBlob(canvas);
  const png = new Uint8Array(await blob.arrayBuffer());
  canvas.width = canvas.height = 0;
  return { png, width: image.width, height: image.height };
}

function bytesToDataUrl(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let start = 0; start < bytes.length; start += chunk) {
    binary += String.fromCharCode(...bytes.subarray(start, start + chunk));
  }
  return `data:image/png;base64,${btoa(binary)}`;
}

function bytesFromDataUrl(url: string): Uint8Array {
  const encoded = url.slice(url.indexOf(',') + 1);
  const binary = atob(encoded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function decodedImage(bytes: Uint8Array, mime = 'image/png'): Promise<ImageData> {
  const bitmap = await createImageBitmap(new Blob([bytes.slice().buffer], { type: mime }));
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = context2d(canvas);
    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, canvas.width, canvas.height);
  } finally { bitmap.close(); }
}

async function savedAsset(saved: SavedSignature): Promise<SignatureAsset> {
  const png = bytesFromDataUrl(saved.pngDataUrl);
  const image = await decodedImage(png);
  return { png, width: image.width, height: image.height };
}

function englishName(value: string): boolean {
  return !!value.trim() && /^[A-Za-z .'-]+$/.test(value);
}

export function SignatureMaker({ onDone, onCancel }: SignatureMakerProps) {
  const [tab, setTab] = useState<MakerTab>('draw');
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const activeStroke = useRef<Stroke | null>(null);
  const drawCanvas = useRef<HTMLCanvasElement | null>(null);
  const [drawInk, setDrawInk] = useState<InkColour>('black');
  const [thickness, setThickness] = useState(3);
  const [typedName, setTypedName] = useState('');
  const [typeFont, setTypeFont] = useState<TypeFontId>('caveat');
  const [typeInk, setTypeInk] = useState<InkColour>('black');
  const [uploadSource, setUploadSource] = useState<ImageData | null>(null);
  const [uploadName, setUploadName] = useState('');
  const [cleanBackground, setCleanBackground] = useState(true);
  const [strength, setStrength] = useState(50);
  const [removeLines, setRemoveLines] = useState(true);
  const [uploadInk, setUploadInk] = useState<SignatureInk>('original');
  const uploadCanvas = useRef<HTMLCanvasElement | null>(null);
  const [error, setError] = useState('');
  const [remember, setRemember] = useState(false);
  const [saved, setSaved] = useState<SavedSignature[]>(() => listSaved());
  const [chosenSaved, setChosenSaved] = useState<{ saved: SavedSignature; asset: SignatureAsset } | null>(null);
  const [working, setWorking] = useState(false);

  const uploadResult = useMemo(() => {
    if (!uploadSource) return null;
    return cleanBackground
      ? cleanSignature(uploadSource, { strength, removeLines, ink: uploadInk })
      : trimToInk(uploadSource);
  }, [cleanBackground, removeLines, strength, uploadInk, uploadSource]);

  useEffect(() => {
    for (const font of TYPE_FONTS) {
      if (typeof FontFace === 'undefined' || typeof document === 'undefined' || !document.fonts) continue;
      const face = new FontFace(font.family, `url(${font.url})`);
      void face.load().then((loaded) => document.fonts.add(loaded)).catch(() => {});
    }
  }, []);

  useEffect(() => {
    const canvas = drawCanvas.current;
    if (!canvas || (!strokes.length && !activeStroke.current)) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    drawStrokes(context, activeStroke.current ? [...strokes, activeStroke.current] : strokes);
  }, [strokes]);

  useEffect(() => {
    const canvas = uploadCanvas.current;
    if (!canvas || !uploadResult) return;
    canvas.width = uploadResult.width;
    canvas.height = uploadResult.height;
    canvas.getContext('2d')?.putImageData(uploadResult, 0, 0);
  }, [uploadResult]);

  const chooseTab = (next: MakerTab) => {
    setChosenSaved(null);
    setTab(next);
    setError('');
  };

  const pointFor = (event: ReactPointerEvent<HTMLCanvasElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.min(DRAW_WIDTH, Math.max(0, (event.clientX - rect.left) * DRAW_WIDTH / Math.max(1, rect.width))),
      y: Math.min(DRAW_HEIGHT, Math.max(0, (event.clientY - rect.top) * DRAW_HEIGHT / Math.max(1, rect.height))),
    };
  };

  const beginStroke = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* pointer events still work */ }
    activeStroke.current = { points: [pointFor(event)], colour: drawInk, thickness };
    setStrokes((value) => [...value]);
  };
  const continueStroke = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!activeStroke.current || event.buttons === 0) return;
    activeStroke.current.points.push(pointFor(event));
    setStrokes((value) => [...value]);
  };
  const finishStroke = () => {
    if (!activeStroke.current) return;
    const finished = activeStroke.current;
    activeStroke.current = null;
    setStrokes((value) => [...value, finished]);
  };

  async function chooseUpload(file?: File) {
    if (!file) return;
    setError('');
    setChosenSaved(null);
    if (isHeicFile(file)) { setError(HEIC_GUIDANCE); return; }
    if (file.size > MAX_IMAGE_BYTES) { setError('Choose an image smaller than 10 MB.'); return; }
    try {
      const prepared = await prepareImageForPdf(file);
      const image = await decodedImage(prepared.bytes, prepared.mime);
      setUploadSource(shrinkForCleaning(image));
      setUploadName(file.name);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'This image could not be read.');
    }
  }

  async function makeAsset(): Promise<{ asset: SignatureAsset; label: string }> {
    if (chosenSaved) return { asset: chosenSaved.asset, label: chosenSaved.saved.label };
    if (tab === 'draw') {
      const canvas = document.createElement('canvas');
      canvas.width = DRAW_WIDTH * 3;
      canvas.height = DRAW_HEIGHT * 3;
      const context = context2d(canvas);
      drawStrokes(context, strokes, 3);
      return { asset: await imageDataAsset(trimToInk(context.getImageData(0, 0, canvas.width, canvas.height))), label: 'Drawn signature' };
    }
    if (tab === 'type') {
      const chosen = TYPE_FONTS.find((font) => font.id === typeFont) ?? TYPE_FONTS[0];
      await document.fonts?.load?.(`120px "${chosen.family}"`).catch(() => []);
      const measure = document.createElement('canvas');
      const measureContext = context2d(measure);
      measureContext.font = `120px "${chosen.family}"`;
      const metrics = measureContext.measureText(typedName.trim());
      const width = Math.max(240, Math.ceil(metrics.width + 80));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = 190;
      const context = context2d(canvas);
      context.font = `120px "${chosen.family}"`;
      context.fillStyle = typeInk === 'blue' ? '#164ca6' : '#121821';
      context.textBaseline = 'middle';
      context.fillText(typedName.trim(), 40, 96);
      return { asset: await imageDataAsset(trimToInk(context.getImageData(0, 0, canvas.width, canvas.height))), label: typedName.trim() };
    }
    if (!uploadResult) throw new Error('Choose a signature image first.');
    return { asset: await imageDataAsset(uploadResult), label: uploadName.replace(/\.[^.]+$/, '') || 'Uploaded signature' };
  }

  const canUse = chosenSaved || (tab === 'draw' ? strokes.length > 0
    : tab === 'type' ? englishName(typedName)
      : !!uploadResult && hasVisibleInk(uploadResult));

  const finishSignature = async () => {
    if (!canUse || working) return;
    setWorking(true);
    setError('');
    try {
      const { asset, label } = await makeAsset();
      if (remember) {
        saveSignature({ label, pngDataUrl: bytesToDataUrl(asset.png) });
        setSaved(listSaved());
      }
      onDone(asset);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The signature could not be prepared.');
    } finally { setWorking(false); }
  };

  return <div className="signature-maker">
    {saved.length > 0 && <section className="signature-saved" aria-label="Saved signatures">
      <strong>Saved signatures</strong>
      <div>{saved.map((entry) => <span key={entry.id} className={chosenSaved?.saved.id === entry.id ? 'is-selected' : ''}>
        <button type="button" className="signature-saved-pick" onClick={() => {
          setError('');
          void savedAsset(entry).then((asset) => setChosenSaved({ saved: entry, asset })).catch(() => setError('This saved signature could not be read.'));
        }}><img src={entry.pngDataUrl} alt={entry.label} /><small>{entry.label}</small></button>
        <button type="button" className="signature-saved-delete" aria-label={`Delete ${entry.label}`} onClick={() => {
          deleteSaved(entry.id);
          if (chosenSaved?.saved.id === entry.id) setChosenSaved(null);
          setSaved(listSaved());
        }}>×</button>
      </span>)}</div>
    </section>}

    {!chosenSaved ? <>
      <div className="signature-tabs" role="tablist" aria-label="Signature source">
        {(['draw', 'type', 'upload'] as const).map((value) => <button key={value} type="button" role="tab"
          aria-selected={tab === value} onClick={() => chooseTab(value)}>{value[0]!.toUpperCase() + value.slice(1)}</button>)}
      </div>

      {tab === 'draw' && <section className="signature-panel" aria-label="Draw signature">
        <canvas ref={drawCanvas} width={DRAW_WIDTH} height={DRAW_HEIGHT} className="signature-draw-canvas"
          aria-label="Draw your signature" onPointerDown={beginStroke} onPointerMove={continueStroke}
          onPointerUp={finishStroke} onPointerCancel={finishStroke} />
        <div className="signature-controls">
          <label>Ink <select value={drawInk} onChange={(event) => setDrawInk(event.target.value as InkColour)}>
            <option value="black">Black</option><option value="blue">Blue</option>
          </select></label>
          <label>Thickness <select value={thickness} onChange={(event) => setThickness(Number(event.target.value))}>
            <option value="2">2 px</option><option value="3">3 px</option><option value="4">4 px</option>
          </select></label>
          <button type="button" onClick={() => setStrokes((value) => value.slice(0, -1))} disabled={!strokes.length}>Undo stroke</button>
          <button type="button" onClick={() => { activeStroke.current = null; setStrokes([]); }} disabled={!strokes.length}>Clear</button>
        </div>
      </section>}

      {tab === 'type' && <section className="signature-panel" aria-label="Type signature">
        <label className="signature-name">Your name<input value={typedName} onChange={(event) => setTypedName(event.target.value)} /></label>
        {typedName && !englishName(typedName) && <p className="signature-help">Use Draw or Upload for other scripts.</p>}
        <div className="signature-fonts" role="radiogroup" aria-label="Signature font">
          {TYPE_FONTS.map((font) => <button key={font.id} type="button" role="radio" aria-checked={typeFont === font.id}
            onClick={() => setTypeFont(font.id)} style={{ fontFamily: `"${font.family}"` }}>
            <span>{typedName || 'Your name'}</span><small>{font.label}</small>
          </button>)}
        </div>
        <label className="signature-inline-select">Ink <select value={typeInk} onChange={(event) => setTypeInk(event.target.value as InkColour)}>
          <option value="black">Black</option><option value="blue">Blue</option>
        </select></label>
      </section>}

      {tab === 'upload' && <section className="signature-panel" aria-label="Upload signature">
        <label className="signature-upload-button">Choose signature image<input type="file" accept="image/png,image/jpeg,image/webp"
          onClick={(event) => { event.currentTarget.value = ''; }} onChange={(event) => { void chooseUpload(event.target.files?.[0]); }} /></label>
        {uploadSource && <>
          <div className="signature-upload-preview"><canvas ref={uploadCanvas} aria-label="Cleaned signature preview" /></div>
          <label className="tool-checkbox"><input type="checkbox" checked={cleanBackground}
            onChange={(event) => setCleanBackground(event.target.checked)} />Clean up background</label>
          {cleanBackground && <div className="signature-clean-controls">
            <label>Cleaning strength <strong>{strength}</strong><input type="range" min="0" max="100" value={strength}
              onChange={(event) => setStrength(Number(event.target.value))} /></label>
            <label className="tool-checkbox"><input type="checkbox" checked={removeLines}
              onChange={(event) => setRemoveLines(event.target.checked)} />Remove notebook lines</label>
            <label>Ink colour <select value={uploadInk} onChange={(event) => setUploadInk(event.target.value as SignatureInk)}>
              <option value="original">Keep original</option><option value="black">Black</option><option value="blue">Blue</option>
            </select></label>
          </div>}
        </>}
      </section>}
    </> : <section className="signature-chosen">
      <img src={chosenSaved.saved.pngDataUrl} alt={chosenSaved.saved.label} /><strong>{chosenSaved.saved.label}</strong>
      <button type="button" onClick={() => setChosenSaved(null)}>Choose another</button>
    </section>}

    {error && <p className="signature-error" role="alert">{error}</p>}
    <label className="signature-remember"><input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
      <span><strong>Remember on this device</strong><small>Leave this off on a shared or office computer.</small></span>
    </label>
    <div className="signature-actions">
      {onCancel && <button type="button" className="signature-cancel" onClick={onCancel}>Cancel</button>}
      <button type="button" className="signature-use" disabled={!canUse || working} onClick={() => void finishSignature()}>
        {working ? 'Preparing...' : 'Use this signature'}
      </button>
    </div>
  </div>;
}

export { TYPE_FONTS };
