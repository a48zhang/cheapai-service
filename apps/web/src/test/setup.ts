import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// jsdom does not implement the pointer-capture and scrolling APIs used by Radix popovers.
if (!HTMLElement.prototype.hasPointerCapture) HTMLElement.prototype.hasPointerCapture = () => false;
if (!HTMLElement.prototype.setPointerCapture) HTMLElement.prototype.setPointerCapture = vi.fn();
if (!HTMLElement.prototype.releasePointerCapture)
  HTMLElement.prototype.releasePointerCapture = vi.fn();
if (!HTMLElement.prototype.scrollIntoView) HTMLElement.prototype.scrollIntoView = vi.fn();

afterEach(() => {
  cleanup();
});
