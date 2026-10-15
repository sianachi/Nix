import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'io.nix.capacitor',
  appName: 'Nix',
  webDir: 'dist-mobile',
  backgroundColor: '#f2f2f3', // design-token-exempt: the native launch surface matches --color-background before the bundled CSS loads.
  ios: { contentInset: 'never' },
  plugins: {
    CapacitorHttp: { enabled: true },
    CapacitorSQLite: {
      iosDatabaseLocation: 'Library/NoCloud',
      iosIsEncryption: false,
      androidIsEncryption: false,
    },
  },
};
export default config;
