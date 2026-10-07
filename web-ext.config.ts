import { defineWebExtConfig } from 'wxt';

// Machine-specific. Dev mode drives the installed Google Chrome. Chrome 137+ ignores
// --load-extension, so WXT loads the extension over CDP (Extensions.loadUnpacked).
// The profile persists in .wxt/chrome-data (gitignored): sign in to Google and other sites once
// and it sticks across restarts. A fresh, cookie-less profile is what makes Google show
// "unusual traffic" CAPTCHAs.
export default defineWebExtConfig({
  binaries: {
    chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  },
  chromiumArgs: ['--user-data-dir=./.wxt/chrome-data'],
});
