import type { DeviceServices } from './contracts';

/**
 * Placeholder device services. The Orchestrator replaces these with the real
 * src/render and src/printer modules in _layout.tsx.
 */
export const stubDevice: DeviceServices = {
  render: async () => {
    throw new Error('Renderer not available yet');
  },
  printer: {
    ensurePermissions: async () => {
      throw new Error('Printer not available yet');
    },
    scan: async () => {
      throw new Error('Printer not available yet');
    },
    print: async () => {
      throw new Error('Printer not available yet');
    },
  },
};
