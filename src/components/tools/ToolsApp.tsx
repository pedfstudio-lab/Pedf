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
import { lockTool } from '@/lib/tools/lock';
import { unlockTool } from '@/lib/tools/unlock';
import { getTool, listTools, registerTool } from '@/lib/tools/registry';
import { NOT_FOUND_META, TOOLS_META } from '@/lib/site/pageMeta';
import { usePageMeta } from '@/lib/site/usePageMeta';
import { NotFoundPage } from '../NotFoundPage';
import { SiteFooter, SiteHeader } from '../SiteChrome';
import { ToolIcon } from './ToolIcon';
import { ToolPage } from './ToolPage';
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
if (!getTool('lock')) registerTool(lockTool);
if (!getTool('unlock')) registerTool(unlockTool);

/** An address like /tools/compres (a typo or a tool that doesn't exist). */
function ToolNotFound() {
  usePageMeta(NOT_FOUND_META);
  return <NotFoundPage />;
}

function ToolsIndex() {
  const tools = listTools();
  usePageMeta(TOOLS_META);
  return <main id="main-content" className="site-shell tool-main">
    <header className="tool-heading"><h1>PDF tools</h1><p>Work with your PDFs, right on your computer.</p></header>
    <p className="tool-local-note">No uploads. No account. Your files stay with you.</p>
    <div className="tools-grid">
      <a className="tool-card" href={siteHref('/app')}><span className="tool-icon" aria-hidden="true"><ToolIcon name="edit" /></span><h2>Edit PDF</h2><p>Edit text and images, or ask questions about your PDF.</p><span className="tool-card-action">Open editor →</span></a>
      {tools.map((tool) => <a key={tool.slug} className="tool-card" href={siteHref(`/tools/${tool.slug}`)}>
        <span className="tool-icon" aria-hidden="true"><ToolIcon name={tool.slug} /></span>
        <h2>{tool.title}</h2><p>{tool.description}</p><span className="tool-card-action">Open tool →</span>
      </a>)}
    </div>
    {!tools.length && <p className="tool-hint">More local PDF tools are on the way. The editor is ready to use now.</p>}
  </main>;
}

export default function ToolsApp({ slug }: { slug?: string }) {
  const tool = slug ? getTool(slug) : undefined;
  if (slug && !tool) return <ToolNotFound />;
  return <div className="site-page tools-page"><SiteHeader />
    {tool ? <ToolPage key={tool.slug} tool={tool} /> : <ToolsIndex />}
    <SiteFooter />
  </div>;
}
