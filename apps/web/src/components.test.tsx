// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Button, ConfirmForm, Modal } from './components';
import { I18nProvider } from './i18n';
import { ApiError } from './api';

describe('shared interface controls', () => {
  it('provides an accessible button label', () => {
    render(<Button>Save changes</Button>);
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeVisible();
  });

  it('closes a modal with Escape', () => {
    const close = vi.fn();
    render(<I18nProvider><Modal title="Edit product" onClose={close}>Content</Modal></I18nProvider>);
    expect(screen.getByRole('dialog', { name: 'Edit product' })).toBeVisible();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(close).toHaveBeenCalledOnce();
  });

  it('freezes the submitted reason while a retry outcome is uncertain', async () => {
    const confirm = vi.fn().mockRejectedValue(new TypeError('Response lost'));
    render(<I18nProvider><ConfirmForm label="Reason" placeholder="Correction" onConfirm={confirm} onCancel={vi.fn()} /></I18nProvider>);
    const input=screen.getByLabelText('Reason');
    fireEvent.change(input,{target:{value:'Original correction'}});
    fireEvent.submit(input.closest('form')!);
    await waitFor(()=>expect(confirm).toHaveBeenCalledTimes(1));
    expect(input).toBeDisabled();
    fireEvent.submit(input.closest('form')!);
    await waitFor(()=>expect(confirm).toHaveBeenCalledTimes(2));
    expect(confirm).toHaveBeenNthCalledWith(1,'Original correction');
    expect(confirm).toHaveBeenNthCalledWith(2,'Original correction');
  });

  it('unlocks the reason and rotates the command after a definitive rejection', async () => {
    const resetCommand=vi.fn();
    const confirm=vi.fn().mockRejectedValue(new ApiError('VALIDATION_ERROR','Invalid reason',400));
    render(<I18nProvider><ConfirmForm label="Definitive reason" placeholder="Correction" onConfirm={confirm} onCancel={vi.fn()} onDefinitiveFailure={resetCommand}/></I18nProvider>);
    const input=screen.getByLabelText('Definitive reason');
    fireEvent.change(input,{target:{value:'Invalid correction'}});
    fireEvent.submit(input.closest('form')!);
    await waitFor(()=>expect(resetCommand).toHaveBeenCalledOnce());
    expect(input).toBeEnabled();
  });
});
