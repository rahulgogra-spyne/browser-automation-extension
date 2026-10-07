import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';
import { RELAY_PORT, startRelay } from './server/relay';

// Model calls go over the Responses API's WebSocket mode through the relay (server/relay.ts),
// which holds OPENAI_API_KEY; the extension only knows the relay's URL. `pnpm dev` runs the relay
// in-process. `--mode e2e` (mocked tests) points at the harness's fake relay instead.
function relayUrl(mode: string): string {
  if (mode === 'e2e') return 'ws://127.0.0.1:8798';
  return process.env.RELAY_URL ?? `ws://127.0.0.1:${RELAY_PORT}`;
}

let relay: ReturnType<typeof startRelay> | undefined;

// Web pages allowed to talk to the extension (externally_connectable): your product's front end.
// Add its origin at build time, e.g. FE_ORIGINS="https://app.example.com/*". Local dev pages are
// always allowed. These pages can start the flow and receive its results, so keep the list tight.
const FE_MATCHES = ['http://localhost/*', 'http://127.0.0.1/*', ...(process.env.FE_ORIGINS?.split(',').filter(Boolean) ?? [])];

// Public half of .keys/vin-flow.pem. It pins the extension ID (pemgbfmmbggmaogmcdjnpkjnjjleppjo)
// wherever the unpacked folder lives, so the front end can address it. The Chrome Web Store
// assigns its own key and ID on publish.
const MANIFEST_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAzpoCcc/0gYq/Grg5uc7r5Ihx84nmAY/OJ7pUJQBaVqlhkzFXqnhC6Cs+qrQ/oWrE/ecQEXITinuLY0ZDXqtMbJNzj39n5wQ/fzEzb+8KVfQKQNqNQxEjWBck10KSqwOuZbl9mdPk3E699BEnGlf6FryvX735A7GW80EQzQogyWCFCoLdOaVHtpF4insfaav/y/ouxghnWQNQiDM/pBeGZoW8fM8U7qd3rQJDMcTJikSboWSlw8t4hZfWGQEW6VWCmRrtnNkwVGOZ7K231bvE5q9tKV1QDLjS3KPeXtBO/zsxbfAnJ6iP8ipR5BUVAdyloC3W5S2DuA/N82uBVQ4xDQIDAQAB';

// Permission policy: everything the extension needs is a manifest permission, so Chrome
// grants all of it in the single install prompt and nothing is requested at
// runtime.
//   debugger   drive the tab (screenshots + real mouse/keyboard input via CDP).
//              Chrome shows its "VIN Flow started debugging this browser" bar while
//              attached. That bar is the consent signal and cannot be hidden
//              from an extension.
//   sidePanel  the UI; the agent loop runs there, so closing it stops the agent.
//   tabGroups  put the tab being driven into a labelled, coloured group (no install warning)
//   (no storage: the flow is fixed in code and nothing is remembered between runs)
//   tabs       read the active tab's url/title, navigate, wait for loads.
// No host_permissions: the debugger acts on pages without them, and the relay is a
// WebSocket, which extension pages may open freely.
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  dev: { server: { port: 3001 } }, // Helm's dev server uses 3000
  hooks: {
    'server:started': () => {
      relay = startRelay();
    },
    'server:closed': () => {
      relay?.close();
    },
  },
  vite: (env) => ({
    plugins: [tailwindcss()],
    define: {
      __RELAY_URL__: JSON.stringify(relayUrl(env.mode)),
      __FE_MATCHES__: JSON.stringify(FE_MATCHES),
      // Mocked tests start runs from the front end, so each DMS's flow must open a fixture page.
      __E2E_START_URLS__: JSON.stringify(
        env.mode === 'e2e' ? { tekion: 'http://127.0.0.1:8799/tekion/ro-list', vinsolutions: 'http://127.0.0.1:8799/app' } : {},
      ),
    },
    server: {
      cors: { origin: [/^chrome-extension:\/\//, /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/] },
    },
  }),
  manifest: {
    name: 'VIN Flow',
    description: 'Runs one fixed VinSolutions flow on your behalf: you sign in, it does the rest and hands back the result.',
    key: MANIFEST_KEY,
    permissions: ['debugger', 'sidePanel', 'tabs', 'tabGroups'],
    externally_connectable: { matches: FE_MATCHES },
    icons: {
      16: '/icons/icon16.png',
      32: '/icons/icon32.png',
      48: '/icons/icon48.png',
      128: '/icons/icon128.png',
    },
    action: {
      default_title: 'Open VIN Flow',
      default_icon: {
        16: '/icons/icon16.png',
        32: '/icons/icon32.png',
        48: '/icons/icon48.png',
        128: '/icons/icon128.png',
      },
    },
    commands: {
      _execute_action: {
        suggested_key: { default: 'Alt+Shift+V', mac: 'Alt+Shift+V' },
        description: 'Open VIN Flow',
      },
    },
  },
});
