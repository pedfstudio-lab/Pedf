import { PDFArray, PDFDict, PDFDocument, PDFName, PDFStream } from 'pdf-lib';
import type { ContentStreamNode } from './coveredGlyphs';
import type { ContentToken } from './contentStream';
import { nameValue, serializeContentStream, textShowOperators, tokenizeContentStream } from './contentStream';
import { buildPageStreamTree } from './formStreams';
import type { PageStreamTree } from './formStreams';
import type { CoverEdit, PdfRect } from './types';

type Matrix = readonly [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const FILLS = new Set(['f', 'F', 'f*', 'B', 'B*', 'b', 'b*']);
const STROKES = new Set(['S', 's']);
const ENDS = new Set([...FILLS, ...STROKES, 'n']);
interface Operation { index: number; name: string; operands: readonly ContentToken[] }
function operations(tokens: readonly ContentToken[]): Operation[] {
  const result: Operation[] = [], operands: ContentToken[] = [];
  let nesting = 0;
  tokens.forEach((token, index) => {
    if (token.kind === 'whitespace' || token.kind === 'comment') return;
    if (token.kind === 'arrayStart' || token.kind === 'dictStart') nesting += 1;
    if (token.kind === 'arrayEnd' || token.kind === 'dictEnd') nesting -= 1;
    if (token.kind === 'word' && nesting === 0) {
      result.push({ index, name: String(token.value), operands: [...operands] }); operands.length = 0;
    } else if (token.kind === 'inlineImage') operands.length = 0;
    else operands.push(token);
  });
  return result;
}
function multiply(a: Matrix, b: Matrix): Matrix {
  return [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1], a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3],
    a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]];
}
function formFor(resources: PDFDict | undefined, name: string): PDFStream | undefined {
  const stream = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict)?.lookupMaybe(PDFName.of(name), PDFStream);
  return stream?.dict.get(PDFName.of('Subtype')) === PDFName.of('Form') ? stream : undefined;
}
function formMatrix(form: PDFStream): Matrix {
  const array = form.dict.lookupMaybe(PDFName.of('Matrix'), PDFArray);
  if (!array) return IDENTITY;
  const values = array.asArray().map(value => Number(value.toString()));
  if (values.length !== 6 || !values.every(Number.isFinite)) throw new Error('Invalid Form matrix');
  return values as unknown as Matrix;
}
/** Count actual invocations, including aliases, nested forms and other pages. */
export function countShapeFormUses(pdf: PDFDocument): readonly ReadonlyMap<string, number>[] {
  const counts = new Map<PDFStream, number>(), bindings: Map<string, PDFStream>[] = [];
  let visits = 0;
  for (let pageIndex = 0; pageIndex < pdf.getPageCount(); pageIndex += 1) {
    const tree = buildPageStreamTree(pdf, pageIndex);
    if (!tree) throw new Error('Cannot audit all Form invocations');
    const pageBindings = new Map<string, PDFStream>(); bindings.push(pageBindings);
    const walk = (node: ContentStreamNode, resources: PDFDict | undefined, ancestors: ReadonlySet<PDFStream>) => {
      for (const op of operations(node.tokens)) {
        if (op.name !== 'Do') continue;
        const name = op.operands.length ? nameValue(op.operands.at(-1)!) : null;
        if (!name) throw new Error('Invalid Form invocation');
        const form = formFor(resources, name); if (!form) continue;
        if (++visits > 100_000 || ancestors.size > 32 || ancestors.has(form)) throw new Error('Unsafe Form graph');
        const child = node.form(name); if (!child) throw new Error('Cannot decode a Form');
        counts.set(form, (counts.get(form) ?? 0) + 1); pageBindings.set(child.key, form);
        walk(child, form.dict.lookupMaybe(PDFName.of('Resources'), PDFDict) ?? resources, new Set([...ancestors, form]));
      }
    };
    for (const root of tree.roots) walk(root, pdf.getPage(pageIndex).node.Resources() ?? undefined, new Set());
  }
  return bindings.map(page => new Map([...page].map(([key, form]) => [key, counts.get(form)!])));
}
const sourceUses = new WeakMap<Uint8Array, Promise<readonly ReadonlyMap<string, number>[]>>();
/** Preview audits the whole pristine source, not its one copied live page. */
export function sourceShapeFormUses(bytes: Uint8Array): Promise<readonly ReadonlyMap<string, number>[]> {
  let pending = sourceUses.get(bytes);
  if (!pending) {
    pending = PDFDocument.load(bytes, { updateMetadata: false }).then(countShapeFormUses);
    sourceUses.set(bytes, pending);
  }
  return pending;
}
export interface CoveredShapeRewrite { readonly streamKey: string; readonly paintTokenIndex: number; readonly operator: string }
export interface CoveredShapePlan {
  readonly rewrites: readonly CoveredShapeRewrite[];
  readonly satisfied: readonly boolean[];
  readonly removedShapes: number;
  readonly unmatchedShapes: number;
  /** A marker-owned reused Form must not be rewritten even by another removal pass. */
  readonly protectedStreams: readonly string[];
}
interface Path { rect: PdfRect; streamKey: string; paintTokenIndex: number; operator: string; safe: boolean }
function contained(inner: PdfRect, outer: PdfRect, slack = 0.5): boolean {
  return inner.x >= outer.x - slack && inner.y >= outer.y - slack
    && inner.x + inner.w <= outer.x + outer.w + slack && inner.y + inner.h <= outer.y + outer.h + slack;
}
/** Only inspect paths; text, images, extraction and their matching are untouched. */
export function planCoveredShapeRemoval(pdf: PDFDocument, pageIndex: number, covers: readonly Pick<CoverEdit, 'rect' | 'replacesShapes'>[],
  formUses: ReadonlyMap<string, number>, streamTree?: PageStreamTree): CoveredShapePlan {
  const tree = streamTree ?? buildPageStreamTree(pdf, pageIndex); if (!tree) throw new Error('Cannot decode paths');
  const paths: Path[] = [];
  interface State { matrix: Matrix; width: number }
  const walk = (node: ContentStreamNode, resources: PDFDict | undefined, initial: State, ancestors: ReadonlySet<PDFStream>,
    inheritedSafe: boolean, sharedPath?: { points: { x: number; y: number }[]; clipping: boolean }, sharedStack?: State[]) => {
    let state = initial; const stack: State[] = sharedStack ?? [];
    const path = sharedPath ?? { points: [], clipping: false };
    const add = (x: number, y: number) => {
      const m = state.matrix; path.points.push({ x: m[0]*x+m[2]*y+m[4], y: m[1]*x+m[3]*y+m[5] });
    };
    for (const op of operations(node.tokens)) {
      const nums = op.operands.filter(token => token.kind === 'number').map(token => Number(token.value));
      if (op.name === 'q') stack.push(state);
      // An extra Q is ignored, as viewers do; it must not stop the page's text removal.
      else if (op.name === 'Q') state = stack.pop() ?? state;
      else if (op.name === 'cm') {
        if (nums.length !== 6 || !nums.every(Number.isFinite)) throw new Error('Invalid path transform');
        state = { ...state, matrix: multiply(state.matrix, nums as unknown as Matrix) };
      } else if (op.name === 'w') state = { ...state, width: nums[0] ?? 1 };
      else if (op.name === 'm' || op.name === 'l') add(nums[0]!, nums[1]!);
      else if (op.name === 'c' || op.name === 'v' || op.name === 'y') {
        for (let i = 0; i < nums.length; i += 2) add(nums[i]!, nums[i+1]!);
      } else if (op.name === 're') {
        const [x = 0, y = 0, w = 0, h = 0] = nums; add(x,y); add(x+w,y); add(x+w,y+h); add(x,y+h);
      } else if (op.name === 'W' || op.name === 'W*') path.clipping = true;
      else if (ENDS.has(op.name)) {
        // Outlines are recorded too, never removed: a dot that is also stroked
        // (or drawn twice) must keep its patch rather than lose only its fill.
        if ((FILLS.has(op.name) || STROKES.has(op.name)) && path.points.length) {
          let x = Infinity, y = Infinity, right = -Infinity, top = -Infinity;
          for (const point of path.points) {
            x = Math.min(x, point.x); y = Math.min(y, point.y); right = Math.max(right, point.x); top = Math.max(top, point.y);
          }
          const stroke = /^[BbSs]/.test(op.name) ? state.width * Math.max(Math.hypot(state.matrix[0],state.matrix[1]), Math.hypot(state.matrix[2],state.matrix[3])) / 2 : 0;
          paths.push({ rect: { x:x-stroke,y:y-stroke,w:right-x+stroke*2,h:top-y+stroke*2 }, streamKey: node.key,
            paintTokenIndex: op.index, operator: op.name,
            safe: inheritedSafe && !path.clipping && FILLS.has(op.name) && !/^[Bb]/.test(op.name) });
        }
        path.points = []; path.clipping = false;
      } else if (op.name === 'Do') {
        const name = op.operands.length ? nameValue(op.operands.at(-1)!) : null; if (!name) throw new Error('Invalid path Form');
        const form = formFor(resources,name); if (!form) continue;
        if (ancestors.size > 32 || ancestors.has(form)) throw new Error('Recursive path Form');
        const child = node.form(name); if (!child) throw new Error('Cannot decode path Form');
        walk(child, form.dict.lookupMaybe(PDFName.of('Resources'),PDFDict) ?? resources,
          { ...state, matrix: multiply(state.matrix,formMatrix(form)) }, new Set([...ancestors,form]),
          inheritedSafe && formUses.get(child.key) === 1);
      }
    }
    return state;
  };
  let state: State = { matrix: IDENTITY, width: 1 };
  const path = { points: [] as { x: number; y: number }[], clipping: false };
  const stack: State[] = [];
  for (const root of tree.roots) state = walk(root, pdf.getPage(pageIndex).node.Resources() ?? undefined, state, new Set(), true, path, stack);
  const selected = new Map<string, CoveredShapeRewrite>();
  const protectedStreams = new Set<string>();
  let unmatchedShapes = 0;
  const satisfied = covers.map(cover => (cover.replacesShapes ?? []).map(shape => {
    for (const path of paths) {
      if (contained(path.rect,shape.rect) && contained(shape.rect,path.rect) && (formUses.get(path.streamKey) ?? 0) > 1) protectedStreams.add(path.streamKey);
    }
    const matching = paths.filter(path => contained(path.rect,shape.rect) && contained(shape.rect,path.rect)
      && contained(path.rect,cover.rect) && path.safe && Object.values(path.rect).every(Number.isFinite));
    // Anything else still painting inside the dot (its outline, a second copy,
    // a clipped or reused-Form copy) would leave a dot behind: keep the patch.
    const leftover = paths.some(path => !matching.includes(path) && contained(path.rect, shape.rect));
    if (!matching.length || leftover) { unmatchedShapes += 1; return false; }
    for (const match of matching) selected.set(`${match.streamKey}:${match.paintTokenIndex}`, match);
    return true;
  }).every(Boolean));
  return { rewrites: [...selected.values()], satisfied, removedShapes: selected.size, unmatchedShapes, protectedStreams:[...protectedStreams] };
}
/** End a claimed path without painting it; retain every construction/state token. */
export function rewriteShapePaintOperators(tokens: readonly ContentToken[], rewrites: readonly CoveredShapeRewrite[]): Uint8Array | null {
  try {
    const changed = [...tokens];
    for (const rewrite of rewrites) {
      const token = changed[rewrite.paintTokenIndex];
      if (token?.kind !== 'word' || token.value !== rewrite.operator || !FILLS.has(rewrite.operator)) return null;
      changed[rewrite.paintTokenIndex] = { kind:'word',value:'n',raw:new TextEncoder().encode('n') };
    }
    const bytes = serializeContentStream(changed), reparsed = tokenizeContentStream(bytes);
    if (textShowOperators(reparsed).length !== textShowOperators(tokens).length) return null;
    if (reparsed.length !== tokens.length) return null;
    return bytes;
  } catch { return null; }
}
