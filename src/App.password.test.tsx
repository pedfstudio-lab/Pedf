// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PdfPasswordError } from './lib/pdf/passwordError';
import { setPendingFile, takePendingFile, takePendingProject } from './lib/site/pendingFile';
import App from './App';

const mocks = vi.hoisted(() => ({
  loadDocument: vi.fn(),
  exportPdf: vi.fn(),
  lockPdf: vi.fn(),
  projectStore: {
    subscribe: vi.fn(() => () => undefined),
    create: vi.fn(), saveState: vi.fn(), load: vi.fn(), list: vi.fn(), delete: vi.fn(), deleteAll: vi.fn(),
  },
}));

vi.mock('./lib/pdf/loadDocument', () => ({ loadDocument: mocks.loadDocument }));
vi.mock('./lib/export/exportPdf', () => ({ exportPdf: mocks.exportPdf }));
vi.mock('./lib/lockPdf/client', () => ({ lockPdf: mocks.lockPdf }));
vi.mock('./lib/projects/projectStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/projects/projectStore')>()),
  projectStore: mocks.projectStore,
  sha256Hex: vi.fn(async () => 'hash'),
}));
vi.mock('./components/PdfChat', () => ({ PdfChat: () => null }));
vi.mock('./components/SettingsPanel', () => ({ SettingsPanel: () => null }));
vi.mock('./components/sign/SignatureModal', () => ({ SignatureModal: () => null }));
vi.mock('./components/PdfViewer', () => ({ PdfViewer: () => <div data-page-index="0">Page one</div> }));

function loaded(protection?: 'none' | 'restricted' | 'password') {
  return {
    doc: { destroy: vi.fn() },
    originalBytes: new Uint8Array([1, 2, 3]),
    pages: [{ pageIndex: 0, widthPt: 612, heightPt: 792, rotation: 0, boxOffset: { x: 0, y: 0 } }],
    protection,
  };
}
const lockedFile = () => new File(['%PDF-1.7 locked'], 'Statement.pdf', { type: 'application/pdf' });
const passwordBox = () => screen.getByLabelText('Password') as HTMLInputElement;

async function typePassword(password: string) {
  fireEvent.change(passwordBox(), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  takePendingFile();
  takePendingProject();
  mocks.projectStore.list.mockResolvedValue({ status: 'ok', value: [] });
  mocks.exportPdf.mockResolvedValue({ bytes: new Uint8Array([7, 7]), warnings: [] });
  mocks.lockPdf.mockResolvedValue(new Uint8Array([9, 9]));
  Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:edited'), configurable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
});
afterEach(() => { cleanup(); takePendingFile(); takePendingProject(); });

describe('Opening a password-protected PDF', () => {
  it('asks for the password, says when it is wrong, then opens with the right one', async () => {
    mocks.loadDocument.mockImplementation(async (_source: unknown, options?: { password?: string }) => {
      if (!options?.password) throw new PdfPasswordError('needed');
      if (options.password !== 'RAHU1990') throw new PdfPasswordError('incorrect');
      return loaded('password');
    });
    setPendingFile(lockedFile());
    render(<App />);

    const dialog = await screen.findByRole('dialog', { name: /This PDF is password-protected/ });
    expect(dialog.textContent).toContain('Statement.pdf');
    expect(dialog.textContent).toContain('The password stays on this device');
    expect(screen.queryByText("That password isn't right. Try again.")).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try Repair PDF' })).toBeNull();
    // Chrome must not drop a password it saved for this site into the box, or offer to save the PDF's.
    expect(passwordBox().getAttribute('autocomplete')).toBe('new-password');
    expect(passwordBox().getAttribute('data-1p-ignore')).toBe('true');
    expect(passwordBox().closest('form')).toBeNull();

    await typePassword('wrong');
    expect(await screen.findByText("That password isn't right. Try again.")).toBeTruthy();
    expect(passwordBox().value).toBe('');

    await typePassword('RAHU1990');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByText('Statement.pdf')).toBeTruthy();
    expect(mocks.loadDocument).toHaveBeenLastCalledWith(expect.any(File), { password: 'RAHU1990' });
    expect(screen.getByText('This PDF was opened with its password.')).toBeTruthy();
    expect((screen.getByLabelText('Keep the password on the downloaded PDF') as HTMLInputElement).checked).toBe(false);
  });

  it('closes the box on Cancel without opening anything', async () => {
    mocks.loadDocument.mockRejectedValue(new PdfPasswordError('needed'));
    setPendingFile(lockedFile());
    render(<App />);
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('region', { name: 'PDF drop area' })).toBeTruthy();
  });

  it('opens a restricted PDF straight away, with no password box or password bar', async () => {
    mocks.loadDocument.mockResolvedValue(loaded('restricted'));
    setPendingFile(new File(['%PDF-1.7'], 'Restricted.pdf', { type: 'application/pdf' }));
    render(<App />);
    expect(await screen.findByText('Restricted.pdf')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('This PDF was opened with its password.')).toBeNull();
  });

  it('downloads unlocked by default, and puts the same password back only when the box is ticked', async () => {
    mocks.loadDocument.mockImplementation(async (_source: unknown, options?: { password?: string }) => {
      if (!options?.password) throw new PdfPasswordError('needed');
      return loaded('password');
    });
    setPendingFile(lockedFile());
    render(<App />);
    await screen.findByRole('dialog');
    await typePassword('1234');
    await screen.findByText('This PDF was opened with its password.');

    fireEvent.click(screen.getByRole('button', { name: /Download PDF/ }));
    await screen.findByText('Your PDF is ready');
    expect(mocks.lockPdf).not.toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText('Keep the password on the downloaded PDF'));
    fireEvent.click(screen.getByRole('button', { name: /Download PDF/ }));
    await waitFor(() => expect(mocks.lockPdf).toHaveBeenCalledTimes(1));
    // A 4-digit bank password is allowed here: it's the file's own password, not a new one.
    expect(mocks.lockPdf).toHaveBeenCalledWith(new Uint8Array([7, 7]), '1234', expect.any(AbortSignal), undefined, { existingPassword: true });
  });

  it('says so, instead of downloading without the password, when it cannot be put back', async () => {
    mocks.loadDocument.mockImplementation(async (_source: unknown, options?: { password?: string }) => {
      if (!options?.password) throw new PdfPasswordError('needed');
      return loaded('password');
    });
    mocks.lockPdf.mockRejectedValue(new Error('signed'));
    setPendingFile(lockedFile());
    render(<App />);
    await screen.findByRole('dialog');
    await typePassword('1234');
    fireEvent.click(await screen.findByLabelText('Keep the password on the downloaded PDF'));
    fireEvent.click(screen.getByRole('button', { name: /Download PDF/ }));
    expect(await screen.findByText(/Couldn't put the password back on this PDF/)).toBeTruthy();
    expect(screen.queryByText('Your PDF is ready')).toBeNull();
  });
});
