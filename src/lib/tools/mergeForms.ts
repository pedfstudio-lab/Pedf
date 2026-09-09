import { PDFArray, PDFBool, PDFDict, PDFHexString, PDFName, PDFObjectCopier, PDFRef, PDFString } from 'pdf-lib';
import type { PDFDocument, PDFPage } from 'pdf-lib';

/** Register the field trees already copied with page widgets; do not copy them a second time. */
export function preserveMergeForms(source: PDFDocument, output: PDFDocument, pages: PDFPage[], fileIndex: number): void {
  const sourceForm = source.catalog.AcroForm();
  if (!sourceForm) return;
  const targetForm = output.catalog.getOrCreateAcroForm();
  const copier = PDFObjectCopier.for(source.context, output.context);
  const resources = sourceForm.lookupMaybe(PDFName.of('DR'), PDFDict);
  const resourceNames = new Map<string, string>();
  if (resources) {
    const targetResources = targetForm.dict.lookupMaybe(PDFName.of('DR'), PDFDict) ?? output.context.obj({});
    for (const [category, value] of resources.entries()) {
      const entries = source.context.lookup(value);
      if (!(entries instanceof PDFDict)) continue;
      const targetEntries = targetResources.lookupMaybe(category, PDFDict) ?? output.context.obj({});
      for (const [name, resource] of entries.entries()) {
        const uniqueName = PDFName.of(`merge${fileIndex + 1}_${name.decodeText()}`);
        targetEntries.set(uniqueName, copier.copy(resource));
        resourceNames.set(name.toString(), uniqueName.toString());
      }
      targetResources.set(category, targetEntries);
    }
    targetForm.dict.set(PDFName.of('DR'), targetResources);
  }

  const roots = new Map<PDFDict, PDFRef>();
  for (const page of pages) {
    const annotations = page.node.Annots();
    if (!annotations) continue;
    for (const annotation of annotations.asArray()) {
      const widget = output.context.lookup(annotation);
      if (!(widget instanceof PDFDict) || widget.get(PDFName.of('Subtype')) !== PDFName.of('Widget')) continue;
      let field: PDFDict = widget;
      // copyPages can leave /P pointing to a detached copy of the original page.
      field.set(PDFName.of('P'), page.ref);
      let ref = annotation instanceof PDFRef ? annotation : output.context.register(field);
      const visited = new Set<PDFDict>();
      while (field.has(PDFName.of('Parent'))) {
        if (visited.has(field)) throw new Error('Invalid form field tree.');
        visited.add(field);
        const parent = field.lookup(PDFName.of('Parent'), PDFDict);
        const parentRef = field.get(PDFName.of('Parent'));
        ref = parentRef instanceof PDFRef ? parentRef : output.context.register(parent);
        field = parent;
      }
      roots.set(field, ref);
    }
  }

  const usedNames = new Set(targetForm.getFields().map(([field]) => field.getPartialName()));
  for (const [root, ref] of roots) {
    const name = root.lookupMaybe(PDFName.of('T'), PDFString, PDFHexString)?.decodeText() || 'field';
    let uniqueName = name;
    let suffix = 2;
    while (usedNames.has(uniqueName)) uniqueName = `${name}_${suffix++}`;
    root.set(PDFName.of('T'), PDFHexString.fromText(uniqueName));
    usedNames.add(uniqueName);
    // Preserve defaults previously inherited from the source document's AcroForm.
    for (const key of ['DA', 'Q']) {
      const value = sourceForm.get(PDFName.of(key));
      if (!root.has(PDFName.of(key)) && value) root.set(PDFName.of(key), copier.copy(value));
    }
    const visited = new Set<PDFDict>();
    const updateAppearanceNames = (dict: PDFDict) => {
      if (visited.has(dict)) return;
      visited.add(dict);
      const appearance = dict.lookupMaybe(PDFName.of('DA'), PDFString, PDFHexString);
      if (appearance) {
        const text = appearance instanceof PDFString ? appearance.asString() : appearance.decodeText();
        dict.set(PDFName.of('DA'), PDFString.of(text.replace(/\/[^\s()<>[\]{}/%]+/g, (token) => resourceNames.get(token) ?? token)));
      }
      const kids = dict.lookupMaybe(PDFName.of('Kids'), PDFArray);
      for (const kid of kids?.asArray() ?? []) {
        const child = output.context.lookup(kid);
        if (child instanceof PDFDict) updateAppearanceNames(child);
      }
    };
    updateAppearanceNames(root);
    targetForm.addField(ref);
  }
  if (sourceForm.get(PDFName.of('NeedAppearances')) === PDFBool.True) {
    targetForm.dict.set(PDFName.of('NeedAppearances'), PDFBool.True);
  }
}
