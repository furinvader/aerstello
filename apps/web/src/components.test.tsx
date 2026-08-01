// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Button, Modal } from './components';
import { I18nProvider } from './i18n';

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
});
