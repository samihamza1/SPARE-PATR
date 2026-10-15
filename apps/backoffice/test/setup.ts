// jsdom lacks a few browser APIs Mantine relies on.
import { notifications } from '@mantine/notifications';
import { afterEach, vi } from 'vitest';

// Mantine keeps notifications in a module-level store; one test's must not show in the next.
afterEach(() => {
  notifications.clean();
});

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }),
});

class ResizeObserverStub {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}
window.ResizeObserver = ResizeObserverStub;
window.HTMLElement.prototype.scrollIntoView = vi.fn();
