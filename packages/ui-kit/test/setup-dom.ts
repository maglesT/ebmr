/** Set-up of the Vitest `dom` project (ui-kit and web): unmount rendered trees after each test. */
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});
