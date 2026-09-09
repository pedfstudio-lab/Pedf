import { useEffect, useState } from 'react';
import { isPdf } from '@/lib/site/pdfFile';
import { friendlyError } from '@/lib/tools/pdfIo';
import { previewPdf } from '@/lib/tools/preview';

export function ToolFilePreview({ file }: { file: File }) {
  const [preview, setPreview] = useState<{ thumbnail: string; pages?: number } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setPreview(null);
    setError('');
    if (!isPdf(file)) {
      const url = URL.createObjectURL(file);
      setPreview({ thumbnail: url });
      return () => URL.revokeObjectURL(url);
    }
    void previewPdf(file, controller.signal).then((result) => {
      if (!controller.signal.aborted) setPreview(result);
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(friendlyError(reason));
    });
    return () => controller.abort();
  }, [file]);

  return <div className="tool-file-preview">
    {preview ? <img src={preview.thumbnail} alt={`Preview of ${file.name}`} /> : <span className="tool-file-placeholder" aria-hidden="true">PDF</span>}
    <span className={error ? 'tool-file-error' : ''}>
      {error || (preview ? (preview.pages !== undefined ? `${preview.pages} ${preview.pages === 1 ? 'page' : 'pages'}` : 'Image') : 'Reading PDF…')}
    </span>
  </div>;
}
