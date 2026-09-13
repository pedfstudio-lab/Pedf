import { siteHref } from '@/lib/site/config';
import { copyTool } from '@/lib/tools/copy';
import { mergeTool } from '@/lib/tools/merge';
import { splitTool } from '@/lib/tools/split';
import { jpgToPdfTool } from '@/lib/tools/jpgToPdf';
import { pdfToJpgTool } from '@/lib/tools/pdfToJpg';
import { rotateTool } from '@/lib/tools/rotate';
import { organizeTool } from '@/lib/tools/organize';
import { watermarkTool } from '@/lib/tools/watermark';
import { repairTool } from '@/lib/tools/repair';
import { signTool } from '@/lib/tools/sign';
import { compressTool } from '@/lib/tools/compress';
import { getTool, listTools, registerTool } from '@/lib/tools/registry';
import { SiteFooter, SiteHeader } from '../SiteChrome';
import { ToolPage } from './ToolPage';
import { useToolMetadata } from './useToolMetadata';
import '../landing.css';
import './tools.css';

// The registry and all tool implementations live behind this lazy route boundary.
if (!getTool('copy')) registerTool(copyTool);
if (!getTool('merge')) registerTool(mergeTool);
if (!getTool('split')) registerTool(splitTool);
if (!getTool('jpg-to-pdf')) registerTool(jpgToPdfTool);
if (!getTool('pdf-to-jpg')) registerTool(pdfToJpgTool);
if (!getTool('rotate')) registerTool(rotateTool);
if (!getTool('organize')) registerTool(organizeTool);
if (!getTool('watermark')) registerTool(watermarkTool);
if (!getTool('repair')) registerTool(repairTool);
if (!getTool('sign')) registerTool(signTool);
if (!getTool('compress')) registerTool(compressTool);

function ToolsIndex() {
  const tools = listTools();
  useToolMetadata('PDF tools', 'Work with PDFs locally in your browser. Your files are never uploaded.');
  return <main className="site-shell tool-main">
    <header className="tool-heading"><h1>PDF tools</h1><p>Work with your PDFs, right on your computer.</p></header>
    <p className="tool-local-note">No uploads. No account. Your files stay with you.</p>
    <div className="tools-grid">
      <a className="tool-card" href={siteHref('/app')}><span className="tool-icon" aria-hidden="true">✎</span><h2>Edit PDF</h2><p>Edit text and images, or ask questions about your PDF.</p><span className="tool-card-action">Open editor →</span></a>
      {tools.map((tool) => <a key={tool.slug} className="tool-card" href={siteHref(`/tools/${tool.slug}`)}>
        <span className="tool-icon" aria-hidden="true">{tool.icon ?? '▤'}</span>
        <h2>{tool.title}</h2><p>{tool.description}</p><span className="tool-card-action">Open tool →</span>
      </a>)}
    </div>
    {!tools.length && <p className="tool-hint">More local PDF tools are on the way. The editor is ready to use now.</p>}
  </main>;
}

export default function ToolsApp({ slug }: { slug?: string }) {
  const tool = slug ? getTool(slug) : undefined;
  return <div className="site-page tools-page"><SiteHeader />
    {tool ? <ToolPage key={tool.slug} tool={tool} /> : <ToolsIndex />}
    <SiteFooter />
  </div>;
}
